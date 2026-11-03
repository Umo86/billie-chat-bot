import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botMailboxes, bots, emailSuggestions, sources } from "@/lib/db/schema";
import { microsoftConfigured } from "@/lib/config";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { inBots } from "@/lib/auth/bots";
import type { Actor } from "@/lib/authz";
import { pastMail } from "@/lib/channels/outlook";
import { mailboxProblem } from "./mailbox-rules";
import { AiError, structured } from "@/lib/ai/provider";
import { modelsFor } from "@/lib/ai/chosen";
import { historySystem, historyUser } from "@/lib/ai/prompts";
import { historyJsonSchema, historySchema } from "@/lib/ai/schemas";
import { aiLimit, LIMIT_LINE, recordUsage } from "@/lib/ai/usage";
import { addSource } from "@/lib/knowledge/sources";
import { knowledgeBaseOf } from "@/lib/knowledge/bases";
import { questionKey } from "@/lib/knowledge/gaps";
import {
  BATCH,
  buildPairs,
  MAX_INBOUND,
  MAX_REPLIES,
  mergeFound,
  worthOffering,
  type Found,
  type Pair,
} from "./history-rules";

/**
 * Turning a mailbox's past emails into knowledge: Billie reads the replies
 * the team sent over the past months (up to 300) with the emails they
 * answered, asks the Fast model which questions come up and what the team
 * answered, and offers the most asked on the Knowledge page as typed answers
 * to check and save. The emails themselves are only read in the job, never
 * stored; what's kept is the general question, the answer and how often it
 * was asked. Nothing changes in the mailbox.
 */

export const HISTORY_MONTHS = [3, 6, 12] as const;

/** Starts a read of the mailbox's past emails (one at a time per mailbox). */
export async function startHistory(actor: Actor, botId: string, months: number): Promise<void> {
  if (!microsoftConfigured()) throw new UserError("Microsoft 365 isn't connected yet.");
  const box = await db.query.botMailboxes.findFirst({ where: eq(botMailboxes.botId, botId) });
  if (!box) throw new UserError("Add the event's mailbox first.");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(botMailboxes)
      .set({ historyStatus: "reading", historyNote: null, historyAt: new Date() })
      .where(
        and(
          eq(botMailboxes.id, box.id),
          sql`${botMailboxes.historyStatus} IS DISTINCT FROM 'reading'`,
        ),
      )
      .returning({ id: botMailboxes.id });
    if (!row) throw new UserError("Billie is already reading this mailbox's past emails.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "update",
      summary: `Asked Billie to learn from ${box.address}'s past ${months} months of emails`,
    });
    await enqueue(
      "email_history",
      { botId, months },
      { tx, dedupeKey: `history:${box.id}`, maxAttempts: 2 },
    );
  });
  await kickJobs({ long: true });
}

/** The "email_history" job. */
export async function readHistory(
  botId: string,
  months: number,
  opts: { lastTry?: boolean; now?: Date } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const box = await db.query.botMailboxes.findFirst({ where: eq(botMailboxes.botId, botId) });
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
  });
  if (!box || !bot) return;
  const finish = (status: "done" | "failed", note: string) =>
    db
      .update(botMailboxes)
      .set({ historyStatus: status, historyNote: note, historyAt: new Date() })
      .where(eq(botMailboxes.id, box.id));

  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - Math.min(Math.max(months, 1), 12));
  let pairs: Pair[];
  try {
    const mail = await pastMail(box.address, since, {
      sent: MAX_REPLIES * 2,
      inbound: MAX_INBOUND,
    });
    pairs = buildPairs(mail.sent, mail.inbound, box.address);
  } catch (err) {
    if (opts.lastTry) return void (await finish("failed", mailboxProblem(err)));
    throw err; // tried again shortly
  }
  if (!pairs.length)
    return void (await finish(
      "done",
      "No replies found to learn from: the team's replies should be in the mailbox's Sent Items.",
    ));

  const found: Found[][] = [];
  const models = await modelsFor("fast");
  for (let i = 0; i < pairs.length; i += BATCH) {
    const limit = await aiLimit("staff");
    if (limit) {
      if (!found.length) return void (await finish("failed", `${LIMIT_LINE[limit]}.`));
      break; // keep what was found so far
    }
    const batch = pairs.slice(i, i + BATCH);
    try {
      const result = await structured({
        purpose: "email_history",
        ...models,
        system: historySystem(bot.showName),
        user: historyUser(batch),
        schema: historyJsonSchema,
        maxTokens: 2000,
        fake: { purpose: "email_history", pairs: batch },
      });
      await recordUsage("history", result.usage, result.model).catch(() => undefined);
      const parsed = historySchema.safeParse(result.json);
      if (!parsed.success) continue;
      found.push(
        parsed.data.items.map((it) => ({
          question: it.question,
          answer: it.answer,
          count: new Set(it.emails.filter((n) => n >= 1 && n <= batch.length)).size || 1,
        })),
      );
    } catch (err) {
      if (err instanceof AiError && err.code === "not_configured")
        return void (await finish("failed", "Claude isn't connected yet (ANTHROPIC_API_KEY)."));
      // One batch that went wrong doesn't spoil the rest.
      console.warn("history batch skipped", err instanceof Error ? err.message : err);
    }
  }

  // Not what the bot already has as a typed answer, or what the team saved or dismissed before.
  const kb = await knowledgeBaseOf(botId);
  const typed = await db
    .select({ title: sources.title })
    .from(sources)
    .where(
      and(eq(sources.knowledgeBaseId, kb.id), eq(sources.kind, "qa"), isNull(sources.deletedAt)),
    );
  const have = new Set(typed.map((t) => questionKey(t.title)));
  const offer = worthOffering(mergeFound(found).filter((f) => !have.has(f.key)));
  for (const f of offer)
    await db
      .insert(emailSuggestions)
      .values({ botId, questionKey: f.key, question: f.question, answer: f.answer, count: f.count })
      .onConflictDoUpdate({
        target: [emailSuggestions.botId, emailSuggestions.questionKey],
        set: { question: f.question, answer: f.answer, count: f.count },
        setWhere: sql`${emailSuggestions.status} = 'offered'`,
      });
  await finish(
    "done",
    `Read ${pairs.length} ${pairs.length === 1 ? "reply" : "replies"}: ${offer.length} ${offer.length === 1 ? "question" : "questions"} to check on the Knowledge page.`,
  );
}

export type SuggestionRow = {
  id: string;
  botId: string;
  botName: string;
  question: string;
  answer: string;
  count: number;
};

/** Offered ones for the actor's bots (null: every bot), most asked first. */
export async function emailSuggestionsFor(ids: string[] | null): Promise<SuggestionRow[]> {
  return db
    .select({
      id: emailSuggestions.id,
      botId: emailSuggestions.botId,
      botName: bots.name,
      question: emailSuggestions.question,
      answer: emailSuggestions.answer,
      count: emailSuggestions.count,
    })
    .from(emailSuggestions)
    .innerJoin(bots, eq(bots.id, emailSuggestions.botId))
    .where(
      and(
        eq(emailSuggestions.status, "offered"),
        isNull(bots.deletedAt),
        inBots(ids, emailSuggestions.botId),
      ),
    )
    .orderBy(desc(emailSuggestions.count), emailSuggestions.question)
    .limit(200);
}

/** Saved as a typed answer in the bot's knowledge (as edited by the person). */
export async function saveSuggestion(
  actor: Actor,
  id: string,
  qa: { question: string; answer: string },
): Promise<void> {
  const row = await db.query.emailSuggestions.findFirst({ where: eq(emailSuggestions.id, id) });
  if (!row || row.status !== "offered")
    throw new UserError("That suggestion is no longer waiting.");
  const kb = await knowledgeBaseOf(row.botId);
  const sourceId = await addSource(actor, kb.id, { kind: "qa", ...qa });
  await db
    .update(emailSuggestions)
    .set({ status: "saved", savedSourceId: sourceId })
    .where(eq(emailSuggestions.id, id));
}

export async function dismissSuggestions(actor: Actor, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.transaction(async (tx) => {
    const gone = await tx
      .update(emailSuggestions)
      .set({ status: "dismissed" })
      .where(and(inArray(emailSuggestions.id, ids), eq(emailSuggestions.status, "offered")))
      .returning({ botId: emailSuggestions.botId });
    for (const botId of new Set(gone.map((g) => g.botId)))
      await writeAudit(tx, {
        actorUserId: actor.id,
        entityType: "bot",
        entityId: botId,
        action: "status_change",
        summary: `Dismissed ${gone.filter((g) => g.botId === botId).length} suggested answers from past emails`,
      });
  });
}

/** For the Email step: how the last read went. */
export async function historyState(botId: string) {
  const box = await db.query.botMailboxes.findFirst({
    where: eq(botMailboxes.botId, botId),
    columns: { historyStatus: true, historyNote: true, historyAt: true },
  });
  const [{ waiting }] = await db
    .select({ waiting: sql<number>`count(*)::int` })
    .from(emailSuggestions)
    .where(and(eq(emailSuggestions.botId, botId), eq(emailSuggestions.status, "offered")));
  return {
    status: box?.historyStatus ?? null,
    note: box?.historyNote ?? null,
    at: box?.historyAt?.toISOString() ?? null,
    waiting,
  };
}
