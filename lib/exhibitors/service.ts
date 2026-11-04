import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { blueprintLinks, bots, exhibitorLists, exhibitors, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { emailConfigured } from "@/lib/config";
import type { Actor } from "@/lib/authz";
import {
  ListError,
  looksInternal,
  readListFile,
  readRows,
  recordText,
  type ListedExhibitor,
} from "./list";

/**
 * A bot's exhibitor list: uploaded on its Exhibitors step, replaced whole by
 * each upload. Personal data, so it's in privacy requests, goes with the
 * bot, and is only ever shown to people who work on the bot.
 */

/** The bot's exhibitor list: one change at a time (an upload, BluePrint, a removal). */
export async function lockList(tx: Tx, botId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`exhibitor-list:${botId}`}))`);
}

export type ListSummary = {
  fileName: string;
  rows: number;
  skipped: number;
  columns: string[];
  /** Columns Billie never reads about an exhibitor. */
  hiddenColumns: string[];
  uploadedAt: string;
  uploadedBy: string | null;
  /** A spreadsheet someone uploaded, or the list BluePrint sends. */
  source: "upload" | "blueprint";
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
  // The team's choice of columns to keep to itself carries over; new columns
  // that look internal (notes, credit status) start hidden.
  const before = await db.query.exhibitorLists.findFirst({
    where: eq(exhibitorLists.botId, botId),
    columns: { columns: true, hiddenColumns: true },
  });
  const hiddenColumns = read.columns.filter((c) =>
    before?.columns.includes(c) ? before.hiddenColumns.includes(c) : looksInternal(c),
  );
  await db.transaction(async (tx) => {
    await lockList(tx, botId);
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
        hiddenColumns,
        rows: read.exhibitors.length,
        skipped: read.skipped,
        source: "upload",
        uploadedBy: actor.id,
        uploadedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: exhibitorLists.botId,
        set: {
          fileName: file.name.slice(0, 200),
          columns: read.columns,
          hiddenColumns,
          rows: read.exhibitors.length,
          skipped: read.skipped,
          source: "upload",
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

/** Which columns Billie may read about a signed-in exhibitor (the rest it never sees). */
export async function setHiddenColumns(
  actor: Actor,
  botId: string,
  hidden: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const [list] = await tx
      .select({ columns: exhibitorLists.columns })
      .from(exhibitorLists)
      .where(eq(exhibitorLists.botId, botId))
      .for("update");
    if (!list) throw new UserError("Upload the exhibitor list first.");
    const keep = list.columns.filter((c) => hidden.includes(c));
    await tx
      .update(exhibitorLists)
      .set({ hiddenColumns: keep })
      .where(eq(exhibitorLists.botId, botId));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "update",
      summary: keep.length
        ? `Kept ${keep.length} exhibitor list ${keep.length === 1 ? "column" : "columns"} from Billie: ${keep.join(", ")}`.slice(
            0,
            300,
          )
        : "Let Billie use every exhibitor list column",
    });
  });
}

export async function removeList(actor: Actor, botId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockList(tx, botId);
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
    hiddenColumns: list.hiddenColumns,
    uploadedAt: list.uploadedAt.toISOString(),
    uploadedBy: by?.fullName ?? null,
    source: list.source,
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

/** The signed-in exhibitor's record, as Billie answers from it: never the columns the team keeps to itself. */
export function exhibitorRecord(
  e: {
    company: string;
    stand: string;
    name: string;
    emails: string[];
    fields: Record<string, string>;
  },
  hidden: string[] = [],
): string {
  const fields = Object.fromEntries(Object.entries(e.fields).filter(([k]) => !hidden.includes(k)));
  return recordText({ ...e, fields });
}

/** A sign-in lasts a show day: on a shared stand laptop or show-floor iPad, the next person isn't them. */
export const SIGN_IN_HOURS = 12;

export type SignedInChat = {
  exhibitorId: string | null;
  signedInAt: Date | null;
  /** The address they signed in with: it must still be on their row. */
  signedInEmail: string | null;
};

/** The exhibitor a chat is signed in as, while the sign-in lasts. */
export function activeExhibitorId(
  c: Pick<SignedInChat, "exhibitorId" | "signedInAt">,
  now = new Date(),
): string | null {
  if (!c.exhibitorId || !c.signedInAt) return null;
  return now.getTime() - c.signedInAt.getTime() < SIGN_IN_HOURS * 3_600_000 ? c.exhibitorId : null;
}

/**
 * The row a chat is signed in as, while the sign-in lasts and their address
 * is still on it (BluePrint can take one off a row it keeps).
 */
async function signedInRow(c: SignedInChat, now: Date) {
  const id = activeExhibitorId(c, now);
  const ex = id ? await exhibitorById(id) : null;
  if (!ex || (c.signedInEmail && !ex.emails.includes(c.signedInEmail))) return null;
  return ex;
}

/** The exhibitor signed in to a chat: their list row (none if nobody is, or it's lapsed). */
export async function signedInExhibitor(c: SignedInChat, now = new Date()) {
  return signedInRow(c, now);
}

/** What Billie reads about the exhibitor signed in to a chat (none if nobody is). */
export async function recordFor(c: SignedInChat, now = new Date()): Promise<string | null> {
  const ex = await signedInRow(c, now);
  if (!ex) return null;
  const list = await db.query.exhibitorLists.findFirst({
    where: eq(exhibitorLists.botId, ex.botId),
    columns: { hiddenColumns: true },
  });
  return exhibitorRecord(ex, list?.hiddenColumns ?? []);
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

/**
 * Can exhibitors sign in to this bot's chat from BluePrint, the exhibitor
 * manual (lib/exhibitors/blueprint.ts)? An exhibitor bot with the setting
 * on, BluePrint connected and a list. No email needed: BluePrint vouches.
 */
export async function manualSignInOpen(bot: {
  id: string;
  audience: "visitors" | "exhibitors";
  personalAnswers: boolean;
}): Promise<boolean> {
  if (bot.audience !== "exhibitors" || !bot.personalAnswers) return false;
  const [link] = await db
    .select({ botId: blueprintLinks.botId })
    .from(blueprintLinks)
    .where(eq(blueprintLinks.botId, bot.id));
  return Boolean(link) && (await hasList(bot.id));
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
export async function signedInAs(c: SignedInChat, now = new Date()): Promise<SignedIn | null> {
  const ex = await signedInRow(c, now);
  return ex ? { name: ex.name, company: ex.company, stand: ex.stand } : null;
}
