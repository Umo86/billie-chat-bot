import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  blueprintLinks,
  bots,
  conversations,
  exhibitorLists,
  exhibitors,
  users,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";
import type { BotRow } from "@/lib/bots/load";
import type { ContactDetails } from "@/lib/types";
import { hashToken, tokensMatch } from "@/lib/chat/token";
import { looksInternal } from "./list";
import { activeExhibitorId, exhibitorByEmail, lockList, type SignedIn } from "./service";

export { manualSignInOpen } from "./service";
import { signInChat } from "./sign-in";
import {
  keyIdOf,
  newKey,
  readToken,
  sameExhibitor,
  signingKeyOf,
  tokenKeyId,
  type ReadSync,
  type SyncRow,
  type TokenProblem,
} from "./blueprint-rules";

/**
 * BluePrint, the exhibitor manual, working with a bot (the rules are in
 * blueprint-rules.ts; the guide for BluePrint is docs/blueprint.md):
 *
 * - An admin connects BluePrint on the bot's Exhibitors step: Billie makes
 *   a key and shows it once, to put in that show's settings in BluePrint.
 * - BluePrint sends the whole exhibitor list with the key whenever it
 *   changes (POST /api/public/blueprint/exhibitors). It replaces the list,
 *   and the same exhibitor keeps the same row, so their sign-ins last.
 * - On its pages, BluePrint signs exhibitors in to the chat: no code by
 *   email. The chat checks the token and that their email is on the list.
 */

export type BlueprintStatus = {
  keyId: string;
  createdAt: string;
  createdBy: string | null;
  lastSyncAt: string | null;
  lastSignInAt: string | null;
};

export async function blueprintStatus(botId: string): Promise<BlueprintStatus | null> {
  const [row] = await db
    .select({
      keyId: blueprintLinks.keyId,
      createdAt: blueprintLinks.createdAt,
      createdBy: users.fullName,
      lastSyncAt: blueprintLinks.lastSyncAt,
      lastSignInAt: blueprintLinks.lastSignInAt,
    })
    .from(blueprintLinks)
    .leftJoin(users, eq(users.id, blueprintLinks.createdBy))
    .where(eq(blueprintLinks.botId, botId));
  return row
    ? {
        keyId: row.keyId,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdBy,
        lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
        lastSignInAt: row.lastSignInAt?.toISOString() ?? null,
      }
    : null;
}

/**
 * Makes the bot's key, replacing any old one (which stops working at once).
 * The key is returned to show once: Billie keeps only what it needs to check it.
 */
export async function makeBlueprintKey(actor: Actor, botId: string): Promise<string> {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
    columns: { audience: true },
  });
  if (!bot) throw new UserError("That bot no longer exists.");
  if (bot.audience !== "exhibitors")
    throw new UserError("Only exhibitor bots work with the exhibitor manual.");
  const { key, keyId } = newKey();
  await db.transaction(async (tx) => {
    const [had] = await tx
      .select({ keyId: blueprintLinks.keyId })
      .from(blueprintLinks)
      .where(eq(blueprintLinks.botId, botId))
      .for("update");
    const values = {
      keyId,
      keyHash: hashToken(key),
      signingKey: signingKeyOf(key),
      createdBy: actor.id,
      createdAt: new Date(),
      lastSyncAt: null,
      lastSignInAt: null,
    };
    await tx
      .insert(blueprintLinks)
      .values({ botId, ...values })
      .onConflictDoUpdate({ target: blueprintLinks.botId, set: values });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "update",
      summary: had
        ? "Made a new BluePrint key (the old one stopped working)"
        : "Connected BluePrint, the exhibitor manual",
    });
  });
  return key;
}

export async function removeBlueprintKey(actor: Actor, botId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(blueprintLinks)
      .where(eq(blueprintLinks.botId, botId))
      .returning({ keyId: blueprintLinks.keyId });
    if (!gone) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "delete",
      summary: "Disconnected BluePrint: its key stopped working",
    });
  });
}

/** The bot a key belongs to, if it's that bot's current key (and the bot still exists). */
export async function botForKey(
  key: string | null,
): Promise<{ botId: string; keyId: string } | null> {
  const keyId = key ? keyIdOf(key) : null;
  if (!key || !keyId) return null;
  const [row] = await db
    .select({ botId: blueprintLinks.botId, keyHash: blueprintLinks.keyHash })
    .from(blueprintLinks)
    .innerJoin(bots, eq(bots.id, blueprintLinks.botId))
    .where(and(eq(blueprintLinks.keyId, keyId), isNull(bots.deletedAt)));
  return row && tokensMatch(key, row.keyHash) ? { botId: row.botId, keyId } : null;
}

// ---------------------------------------------------------------------------
// Signing in from the manual

type Listed = NonNullable<Awaited<ReturnType<typeof exhibitorByEmail>>>;
export type ManualSignIn =
  { ok: true; exhibitor: Listed; email: string } | { ok: false; reason: TokenProblem };

/** Who a sign-in token from BluePrint is for, on this bot's list. */
export async function readManualSignIn(
  bot: Pick<BotRow, "id">,
  token: string,
  now = new Date(),
): Promise<ManualSignIn> {
  const keyId = tokenKeyId(token);
  if (!keyId) return { ok: false, reason: "malformed" };
  const link = await db.query.blueprintLinks.findFirst({
    where: eq(blueprintLinks.keyId, keyId),
    columns: { botId: true, signingKey: true },
  });
  // A token for another show's bot never signs anyone in here.
  if (!link || link.botId !== bot.id) return { ok: false, reason: "unknown_key" };
  const read = readToken(token, link.signingKey, now.getTime());
  if (!read.ok) return read;
  const exhibitor = await exhibitorByEmail(bot.id, read.email);
  if (!exhibitor) return { ok: false, reason: "not_listed" };
  return { ok: true, exhibitor, email: read.email };
}

/** What the chat says when signing in from the manual didn't work. */
export function manualSignInLine(reason: TokenProblem): string {
  if (reason === "expired")
    return "Your sign-in from the exhibitor manual has run out. Reload the manual page, then open the chat again.";
  if (reason === "not_listed")
    return "Billie can't find your email on this show's exhibitor list yet, so it can't answer about your own stand. Ask the team to check the list.";
  return "Billie couldn't sign you in from the exhibitor manual. Reload the manual page, then open the chat again.";
}

/**
 * Signs the chat in from BluePrint. A chat that belongs to someone else (it
 * was signed in as them, even if that's over, or they left their email in
 * it) is left alone ("other"): on a shared laptop the next person gets a
 * chat of their own, never the last person's.
 */
export async function signInFromManual(
  bot: Pick<BotRow, "id" | "name">,
  conversationId: string,
  who: { exhibitor: Listed; email: string },
  now = new Date(),
): Promise<{ result: "signed_in" | "already" | "other"; signedIn: SignedIn }> {
  const signedIn = {
    name: who.exhibitor.name,
    company: who.exhibitor.company,
    stand: who.exhibitor.stand,
  };
  const result = await db.transaction(async (tx) => {
    const [c] = await tx
      .select({
        exhibitorId: conversations.exhibitorId,
        signedInAt: conversations.signedInAt,
        signedInEmail: conversations.signedInEmail,
        contact: conversations.contact,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for("update");
    if (!c) return "other" as const;
    const theirs =
      c.signedInEmail ?? (c.contact as ContactDetails | null)?.email?.trim().toLowerCase() ?? null;
    if (theirs && theirs !== who.email) return "other" as const;
    if (activeExhibitorId(c, now) === who.exhibitor.id) return "already" as const;
    // Not signed in yet, or their own sign-in has run out (or their row changed): sign in again.
    await signInChat(tx, bot, conversationId, who.exhibitor, who.email, now, "manual");
    await tx
      .update(blueprintLinks)
      .set({ lastSignInAt: now })
      .where(eq(blueprintLinks.botId, bot.id));
    return "signed_in" as const;
  });
  return { result, signedIn };
}

// ---------------------------------------------------------------------------
// The exhibitor list from BluePrint

export type SyncResult = {
  exhibitors: number;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
};

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/**
 * Replaces the bot's exhibitor list with BluePrint's. Exhibitors match by
 * BluePrint's id: changed rows are updated in place, new ones added, the
 * rest removed (a spreadsheet's rows too). The team's choice of columns to
 * keep from Billie carries over, as with an upload.
 */
export async function syncFromBlueprint(
  botId: string,
  list: ReadSync,
  now = new Date(),
): Promise<SyncResult> {
  if (!list.rows.length)
    throw new UserError(
      "No exhibitors with an email address in the list, so nothing was changed. Billie needs at least one.",
    );
  return db.transaction(async (tx) => {
    await lockList(tx, botId);
    const bot = await tx.query.bots.findFirst({
      where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
      columns: { audience: true },
    });
    if (!bot || bot.audience !== "exhibitors")
      throw new UserError("This bot isn't an exhibitor bot any more.");

    const existing = await tx
      .select({
        id: exhibitors.id,
        externalId: exhibitors.externalId,
        company: exhibitors.company,
        stand: exhibitors.stand,
        name: exhibitors.name,
        emails: exhibitors.emails,
        fields: exhibitors.fields,
      })
      .from(exhibitors)
      .where(eq(exhibitors.botId, botId));
    const byId = new Map(existing.filter((e) => e.externalId).map((e) => [e.externalId!, e]));
    const kept = new Set<string>();
    const added: SyncRow[] = [];
    const changed: (SyncRow & { id: string })[] = [];
    for (const r of list.rows) {
      const had = byId.get(r.externalId);
      if (!had) {
        added.push(r);
        continue;
      }
      kept.add(had.id);
      if (!sameExhibitor(had, r)) changed.push({ ...r, id: had.id });
    }
    const removed = existing.filter((e) => !kept.has(e.id)).map((e) => e.id);

    for (let i = 0; i < removed.length; i += 1000)
      await tx.delete(exhibitors).where(inArray(exhibitors.id, removed.slice(i, i + 1000)));
    for (let i = 0; i < added.length; i += 500)
      await tx.insert(exhibitors).values(
        added.slice(i, i + 500).map((r) => ({
          botId,
          externalId: r.externalId,
          company: r.company,
          stand: r.stand,
          name: r.name,
          emails: r.emails,
          fields: r.fields,
        })),
      );
    // Many at once: one statement for each few hundred, not one each.
    for (let i = 0; i < changed.length; i += 300) {
      const values = changed.slice(i, i + 300).map(
        (c) =>
          sql`(${c.id}::uuid, ${c.company}, ${c.stand}, ${c.name}, ARRAY[${sql.join(
            c.emails.map((e) => sql`${e}`),
            sql`, `,
          )}]::text[], ${JSON.stringify(c.fields)}::jsonb)`,
      );
      await tx.execute(sql`
        UPDATE exhibitors AS e
        SET company = v.company, stand = v.stand, name = v.name, emails = v.emails, fields = v.fields
        FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, company, stand, name, emails, fields)
        WHERE e.id = v.id AND e.bot_id = ${botId}`);
    }

    const before = await tx.query.exhibitorLists.findFirst({
      where: eq(exhibitorLists.botId, botId),
      columns: { columns: true, hiddenColumns: true, source: true },
    });
    const hiddenColumns = list.columns.filter((c) =>
      before?.columns.includes(c) ? before.hiddenColumns.includes(c) : looksInternal(c),
    );
    const about = {
      fileName: "BluePrint",
      source: "blueprint" as const,
      columns: list.columns,
      hiddenColumns,
      rows: list.rows.length,
      skipped: list.skipped,
      uploadedBy: null,
      uploadedAt: now,
    };
    await tx
      .insert(exhibitorLists)
      .values({ botId, ...about })
      .onConflictDoUpdate({ target: exhibitorLists.botId, set: about });
    await tx.update(blueprintLinks).set({ lastSyncAt: now }).where(eq(blueprintLinks.botId, botId));

    const result = {
      exhibitors: list.rows.length,
      added: added.length,
      updated: changed.length,
      removed: removed.length,
      skipped: list.skipped,
    };
    const columnsChanged =
      !before ||
      before.source !== "blueprint" ||
      before.columns.length !== list.columns.length ||
      before.columns.some((c, i) => c !== list.columns[i]);
    // An update that changed nothing isn't worth a line in the audit log.
    if (result.added || result.updated || result.removed || columnsChanged)
      await writeAudit(tx, {
        actorType: "system",
        entityType: "bot",
        entityId: botId,
        action: "update",
        summary: `BluePrint updated the exhibitor list: ${plural(result.exhibitors, "exhibitor", "exhibitors")} (${result.added} new, ${result.updated} changed, ${result.removed} removed)`,
      });
    return result;
  });
}
