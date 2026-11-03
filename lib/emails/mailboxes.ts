import "server-only";
import { worksOnBotSql } from "@/lib/auth/bots";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botMailboxes, bots, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";
import { normaliseMailbox, teamsLinkLabel, teamsLinkProblem } from "./mailbox-rules";

/**
 * Each bot's event mailbox and Teams channel. Admins only (the actions use
 * settings.manage): connecting a mailbox lets Billie read it, and everyone
 * on the team then sees its emails on the Emails page. The Teams link is a
 * secret, so it is never shown again once saved; the screen gets its host.
 */
export type BotEmailSetup = {
  mailbox: {
    address: string;
    assignedUserId: string | null;
    enabled: boolean;
    lastSyncedAt: Date | null;
    lastError: string | null;
    draftError: string | null;
  } | null;
  /** The saved Teams link's host (e.g. "prod-12.uksouth.logic.azure.com"), never the link. */
  teams: string | null;
};

export async function botEmailSetup(botId: string): Promise<BotEmailSetup> {
  const [mailbox, bot] = await Promise.all([
    db.query.botMailboxes.findFirst({
      where: eq(botMailboxes.botId, botId),
      columns: {
        address: true,
        assignedUserId: true,
        enabled: true,
        lastSyncedAt: true,
        lastError: true,
        draftError: true,
      },
    }),
    db.query.bots.findFirst({ where: eq(bots.id, botId), columns: { teamsWebhookUrl: true } }),
  ]);
  return { mailbox: mailbox ?? null, teams: teamsLinkLabel(bot?.teamsWebhookUrl ?? null) };
}

async function liveBot(botId: string) {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
    columns: { id: true, name: true },
  });
  if (!bot) throw new UserError("That bot no longer exists.");
  return bot;
}

export async function saveMailbox(
  actor: Actor,
  botId: string,
  input: { address: string; assignedUserId: string | null; enabled: boolean },
): Promise<void> {
  const address = normaliseMailbox(input.address);
  if (!address) throw new UserError("That mailbox address doesn't look right.");
  const bot = await liveBot(botId);
  if (input.assignedUserId) {
    const person = await db.query.users.findFirst({
      where: eq(users.id, input.assignedUserId),
      columns: { status: true },
    });
    if (!person || person.status !== "active")
      throw new UserError("Choose someone on the team who can sign in.");
    const [onBot] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.assignedUserId), worksOnBotSql(botId)));
    if (!onBot)
      throw new UserError(
        "They don't work on this bot, so they couldn't open its emails. Add them on the People step first.",
      );
  }
  const [taken] = await db
    .select({ botId: bots.id, name: bots.name, deletedAt: bots.deletedAt })
    .from(botMailboxes)
    .innerJoin(bots, eq(bots.id, botMailboxes.botId))
    .where(and(eq(botMailboxes.address, address), ne(botMailboxes.botId, botId)))
    .limit(1);
  if (taken && !taken.deletedAt)
    throw new UserError(`${taken.name} already uses ${address}. A mailbox can belong to one bot.`);

  await db.transaction(async (tx) => {
    // A deleted bot (still in the bin) gives the mailbox up.
    if (taken) {
      await tx.delete(botMailboxes).where(eq(botMailboxes.botId, taken.botId));
      await writeAudit(tx, {
        actorUserId: actor.id,
        entityType: "bot",
        entityId: taken.botId,
        action: "settings_change",
        summary: `Moved ${address} from the deleted bot "${taken.name}" to "${bot.name}"`,
      });
    }
    const before = await tx.query.botMailboxes.findFirst({
      where: eq(botMailboxes.botId, botId),
      columns: { address: true, assignedUserId: true, enabled: true },
    });
    const moved = before && before.address !== address;
    // Switched back on: Billie starts from now, not with the mail that came in while it was off.
    const restarted = before && !before.enabled && input.enabled;
    const values = {
      address,
      assignedUserId: input.assignedUserId,
      enabled: input.enabled,
      // A different mailbox starts its sync afresh.
      ...(moved
        ? { deltaLink: null, syncFrom: null, lastSyncedAt: null, lastError: null, draftError: null }
        : restarted
          ? { deltaLink: null, syncFrom: null }
          : {}),
    };
    if (before) {
      await tx.update(botMailboxes).set(values).where(eq(botMailboxes.botId, botId));
    } else {
      await tx.insert(botMailboxes).values({ botId, ...values });
    }
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "settings_change",
      summary: before
        ? `Changed the mailbox for "${bot.name}" (${address}${input.enabled ? "" : ", switched off"})`
        : `Connected ${address} to "${bot.name}"`,
      before: before ?? null,
      after: { address, assignedUserId: input.assignedUserId, enabled: input.enabled },
    });
  });
}

/** Billie stops reading the mailbox. Emails already in Billie stay. */
export async function removeMailbox(actor: Actor, botId: string): Promise<void> {
  const bot = await liveBot(botId);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(botMailboxes)
      .where(eq(botMailboxes.botId, botId))
      .returning({ address: botMailboxes.address });
    if (!row) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "settings_change",
      summary: `Disconnected ${row.address} from "${bot.name}"`,
    });
  });
}

/** Saves (or, with null, removes) the bot's Teams channel link. The link never goes in the audit log. */
export async function setTeamsLink(
  actor: Actor,
  botId: string,
  link: string | null,
): Promise<void> {
  const clean = link?.trim() || null;
  if (clean) {
    const problem = teamsLinkProblem(clean);
    if (problem) throw new UserError(problem);
  }
  const bot = await liveBot(botId);
  await db.transaction(async (tx) => {
    await tx.update(bots).set({ teamsWebhookUrl: clean }).where(eq(bots.id, botId));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "settings_change",
      summary: clean
        ? `Set the Teams channel for "${bot.name}" (${teamsLinkLabel(clean)})`
        : `Removed the Teams channel from "${bot.name}"`,
    });
  });
}

/** The Teams link to test with: the bot's own (server-side only). */
export async function teamsLinkOf(botId: string): Promise<string | null> {
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    columns: { teamsWebhookUrl: true },
  });
  return bot?.teamsWebhookUrl ?? null;
}

/** Every event mailbox, for Settings → Connections. */
export async function mailboxOverview() {
  return db
    .select({
      botId: bots.id,
      botName: bots.name,
      address: botMailboxes.address,
      enabled: botMailboxes.enabled,
      lastSyncedAt: botMailboxes.lastSyncedAt,
      lastError: botMailboxes.lastError,
      draftError: botMailboxes.draftError,
      manager: users.fullName,
      teams: bots.teamsWebhookUrl,
    })
    .from(botMailboxes)
    .innerJoin(bots, eq(bots.id, botMailboxes.botId))
    .leftJoin(users, eq(users.id, botMailboxes.assignedUserId))
    .where(isNull(bots.deletedAt))
    .orderBy(asc(bots.name))
    .then((rows) => rows.map(({ teams, ...r }) => ({ ...r, teams: teams !== null })));
}

/** People who can manage a mailbox: everyone on the team who can sign in. */
/** Who can manage a bot's mailbox (and handle its requests): active people who work on the bot. */
export async function mailboxManagers(botId: string) {
  return db
    .select({ id: users.id, name: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.status, "active"), worksOnBotSql(botId)))
    .orderBy(asc(users.fullName));
}
