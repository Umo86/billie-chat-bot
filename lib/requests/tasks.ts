import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { chatRequests, deadlines, exhibitorLists } from "@/lib/db/schema";
import { listSummary, signedInExhibitor, type SignedInChat } from "@/lib/exhibitors/service";
import { isDone } from "@/lib/exhibitors/deadline-rules";
import { buildChecklist } from "@/lib/exhibitors/checklist";
import type { BotRow } from "@/lib/bots/load";
import type { ChatTask, ChecklistItem, ContactField, RequestOffer, RequestType } from "@/lib/types";
import { openTo, type TaskExhibitor } from "./rules";

/**
 * Tasks from the exhibitor manual, done in the chat (an electrics order for
 * a space only stand, the nameboard for a shell scheme one): a request type
 * marked as a task. A signed-in exhibitor gets a button for each one that's
 * for their stand and not done yet, with no Claude call. Done means their
 * deadline's column says so (when the task has a deadline, kept up to date by
 * BluePrint), or they've already sent it through Billie.
 */

type Exhibitor = NonNullable<Awaited<ReturnType<typeof signedInExhibitor>>>;

/** The signed-in exhibitor of a chat, as tasks need them. */
export async function taskExhibitor(c: SignedInChat): Promise<Exhibitor | null> {
  return signedInExhibitor(c);
}

const asTaskExhibitor = (ex: Exhibitor | null): TaskExhibitor | null =>
  ex ? { fields: ex.fields, stand: ex.stand, company: ex.company } : null;

/** The bot's requests this chat may see: those for everyone, and those for this exhibitor's stand. */
export function typesFor(bot: Pick<BotRow, "requestTypes">, ex: Exhibitor | null): RequestType[] {
  return bot.requestTypes.filter((t) => openTo(t, asTaskExhibitor(ex)) === "yes");
}

/** What a signed-in exhibitor's form starts with: who they are, from their row. */
export function knownFor(
  ex: Exhibitor | null,
  email: string | null,
): RequestOffer["known"] | undefined {
  if (!ex) return undefined;
  const known: Partial<Record<ContactField, string>> = {};
  if (ex.name) known.name = ex.name;
  if (ex.company) known.company = ex.company;
  if (ex.stand) known.stand = ex.stand;
  if (email) known.email = email;
  return known;
}

/** The tasks of the bot this exhibitor has already sent through Billie (and not had declined). */
async function sentTasks(exhibitorId: string, typeIds: string[]): Promise<Set<string>> {
  if (!typeIds.length) return new Set();
  const rows = await db
    .select({ typeId: chatRequests.typeId })
    .from(chatRequests)
    .where(
      and(
        eq(chatRequests.exhibitorId, exhibitorId),
        inArray(chatRequests.typeId, typeIds),
        ne(chatRequests.status, "declined"),
      ),
    );
  return new Set(rows.map((r) => r.typeId));
}

/**
 * A signed-in exhibitor's things to do before the show (lib/exhibitors/checklist.ts):
 * the bot's deadlines, ticked off by their row, and its tasks. Deadlines on a
 * column the team keeps from Billie aren't shown.
 */
export async function exhibitorChecklist(
  bot: Pick<BotRow, "id" | "audience" | "requestTypes" | "links">,
  ex: Exhibitor | null,
): Promise<ChecklistItem[]> {
  if (bot.audience !== "exhibitors" || !ex) return [];
  const tasks = bot.requestTypes.filter((t) => t.task);
  const [list, due, sent] = await Promise.all([
    db.query.exhibitorLists.findFirst({
      where: eq(exhibitorLists.botId, bot.id),
      columns: { columns: true, hiddenColumns: true },
    }),
    db.select().from(deadlines).where(eq(deadlines.botId, bot.id)),
    sentTasks(
      ex.id,
      tasks.map((t) => t.id),
    ),
  ]);
  if (!due.length && !tasks.length) return [];
  const open = new Set(typesFor(bot, ex).map((t) => t.id));
  return buildChecklist({
    deadlines: due,
    columns: (list?.columns ?? []).filter((c) => !list?.hiddenColumns.includes(c)),
    fields: ex.fields,
    tasks: tasks.map((t) => ({
      id: t.id,
      name: t.name,
      deadlineId: t.deadlineId ?? null,
      open: open.has(t.id),
    })),
    sent,
    links: bot.links,
  });
}

/** The tasks a signed-in exhibitor still has to do, in the bot's order. */
export async function outstandingTasks(
  bot: Pick<BotRow, "audience" | "requestTypes">,
  ex: Exhibitor | null,
): Promise<ChatTask[]> {
  if (bot.audience !== "exhibitors" || !ex) return [];
  const tasks = typesFor(bot, ex).filter((t) => t.task);
  if (!tasks.length) return [];
  const linked = tasks.map((t) => t.deadlineId).filter((id): id is string => Boolean(id));
  const due = linked.length
    ? await db.select().from(deadlines).where(inArray(deadlines.id, linked))
    : [];
  const sent = await sentTasks(
    ex.id,
    tasks.map((t) => t.id),
  );
  const out: ChatTask[] = [];
  for (const t of tasks) {
    if (sent.has(t.id)) continue;
    const d = due.find((x) => x.id === t.deadlineId);
    if (d && isDone(ex.fields, d.column, d.doneValues)) continue;
    out.push({ typeId: t.id, name: t.name, due: d?.dueOn ?? null });
  }
  return out;
}

/** For the Rules step: the list's columns and the bot's deadlines, to set up tasks with. */
export async function taskChoices(botId: string): Promise<{
  columns: string[];
  deadlines: { id: string; name: string; dueOn: string }[];
}> {
  const [list, due] = await Promise.all([
    listSummary(botId),
    db
      .select({ id: deadlines.id, name: deadlines.name, dueOn: deadlines.dueOn })
      .from(deadlines)
      .where(eq(deadlines.botId, botId))
      .orderBy(deadlines.dueOn),
  ]);
  return { columns: list?.columns ?? [], deadlines: due };
}
