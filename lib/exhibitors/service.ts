import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, exhibitorLists, exhibitors, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { emailConfigured } from "@/lib/config";
import type { Actor } from "@/lib/authz";
import { ListError, readListFile, readRows, recordText, type ListedExhibitor } from "./list";

/**
 * A bot's exhibitor list: uploaded on its Exhibitors step, replaced whole by
 * each upload. Personal data, so it's in privacy requests, goes with the
 * bot, and is only ever shown to people who work on the bot.
 */

export type ListSummary = {
  fileName: string;
  rows: number;
  skipped: number;
  columns: string[];
  uploadedAt: string;
  uploadedBy: string | null;
  sample: (ListedExhibitor & { id: string })[];
};

export async function uploadList(
  actor: Actor,
  botId: string,
  file: { name: string; bytes: Buffer },
): Promise<ListSummary> {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
    columns: { audience: true },
  });
  if (!bot) throw new UserError("That bot no longer exists.");
  if (bot.audience !== "exhibitors")
    throw new UserError("Only exhibitor bots have an exhibitor list.");
  let read;
  try {
    const { header, rows } = await readListFile(file.bytes, file.name);
    read = readRows(header, rows);
  } catch (err) {
    if (err instanceof ListError) throw new UserError(err.message);
    throw err;
  }
  if (!read.found.email)
    throw new UserError(
      'No email column found. Name the column "Email" (one address, or several separated by commas).',
    );
  if (!read.exhibitors.length)
    throw new UserError("No rows with an email address found. Check the email column.");
  await db.transaction(async (tx) => {
    // Sign-ins with the old list end with it (each chat can sign in again).
    await tx.delete(exhibitors).where(eq(exhibitors.botId, botId));
    for (let i = 0; i < read.exhibitors.length; i += 500)
      await tx
        .insert(exhibitors)
        .values(read.exhibitors.slice(i, i + 500).map((e) => ({ botId, ...e })));
    await tx
      .insert(exhibitorLists)
      .values({
        botId,
        fileName: file.name.slice(0, 200),
        columns: read.columns,
        rows: read.exhibitors.length,
        skipped: read.skipped,
        uploadedBy: actor.id,
        uploadedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: exhibitorLists.botId,
        set: {
          fileName: file.name.slice(0, 200),
          columns: read.columns,
          rows: read.exhibitors.length,
          skipped: read.skipped,
          uploadedBy: actor.id,
          uploadedAt: new Date(),
        },
      });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "update",
      summary: `Uploaded the exhibitor list (${read.exhibitors.length} ${read.exhibitors.length === 1 ? "exhibitor" : "exhibitors"}${read.skipped ? `, ${read.skipped} ${read.skipped === 1 ? "row" : "rows"} without an email left out` : ""})`,
    });
  });
  return (await listSummary(botId))!;
}

export async function removeList(actor: Actor, botId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(exhibitors).where(eq(exhibitors.botId, botId));
    const [gone] = await tx
      .delete(exhibitorLists)
      .where(eq(exhibitorLists.botId, botId))
      .returning({ botId: exhibitorLists.botId });
    if (!gone) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "delete",
      summary: "Removed the exhibitor list",
    });
  });
}

export async function listSummary(botId: string): Promise<ListSummary | null> {
  const list = await db.query.exhibitorLists.findFirst({
    where: eq(exhibitorLists.botId, botId),
  });
  if (!list) return null;
  const sample = await db
    .select()
    .from(exhibitors)
    .where(eq(exhibitors.botId, botId))
    .orderBy(asc(exhibitors.company), asc(exhibitors.stand))
    .limit(8);
  const by = list.uploadedBy
    ? await db.query.users.findFirst({
        where: eq(users.id, list.uploadedBy),
        columns: { fullName: true },
      })
    : null;
  return {
    fileName: list.fileName,
    rows: list.rows,
    skipped: list.skipped,
    columns: list.columns,
    uploadedAt: list.uploadedAt.toISOString(),
    uploadedBy: by?.fullName ?? null,
    sample: sample.map((s) => ({
      id: s.id,
      company: s.company,
      stand: s.stand,
      name: s.name,
      emails: s.emails,
      fields: s.fields,
    })),
  };
}

/** The exhibitor with this email on the bot's list, if any. */
export async function exhibitorByEmail(botId: string, email: string) {
  const [row] = await db
    .select()
    .from(exhibitors)
    .where(
      and(
        eq(exhibitors.botId, botId),
        // @> uses the GIN index on emails.
        sql`${exhibitors.emails} @> ARRAY[${email.trim().toLowerCase()}]::text[]`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function exhibitorById(id: string) {
  return (await db.query.exhibitors.findFirst({ where: eq(exhibitors.id, id) })) ?? null;
}

/** The signed-in exhibitor's record, as Billie answers from it. */
export function exhibitorRecord(e: {
  company: string;
  stand: string;
  name: string;
  emails: string[];
  fields: Record<string, string>;
}): string {
  return recordText(e);
}

/**
 * Can exhibitors sign in to this bot's chat? Only an exhibitor bot with the
 * setting on, email sending set up (for the codes) and a list to sign in against.
 */
export async function signInOpen(bot: {
  id: string;
  audience: "visitors" | "exhibitors";
  personalAnswers: boolean;
}): Promise<boolean> {
  return (
    bot.audience === "exhibitors" &&
    bot.personalAnswers &&
    emailConfigured() &&
    (await hasList(bot.id))
  );
}

/** Has the bot a list to sign in against? */
export async function hasList(botId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: exhibitorLists.botId })
    .from(exhibitorLists)
    .where(eq(exhibitorLists.botId, botId));
  return Boolean(row);
}

export type SignedIn = { name: string; company: string; stand: string };

/** Who is signed in to a chat, for the chat and the Inbox. */
export async function signedInAs(exhibitorId: string | null): Promise<SignedIn | null> {
  if (!exhibitorId) return null;
  const ex = await exhibitorById(exhibitorId);
  return ex ? { name: ex.name, company: ex.company, stand: ex.stand } : null;
}
