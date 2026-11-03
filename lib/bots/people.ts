import "server-only";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/lib/db/client";
import { botMembers, bots, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { EVERY_BOT_ROLES, roleWorksOnEveryBot, type Actor, type Role } from "@/lib/authz";

/**
 * Who works on each bot. Admins choose, on the bot's People step; admins
 * work on every bot and are never listed as members. Whoever makes a bot
 * is put on it.
 */
export type BotPerson = {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "active" | "suspended";
  /** Works on every bot (admins), so isn't ticked on or off. */
  everyBot: boolean;
  /** On this bot (admins: always, as they work on every bot). */
  onBot: boolean;
};

/** Everyone on the team, and whether they work on this bot. */
export async function botPeople(botId: string): Promise<BotPerson[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.fullName,
      email: users.email,
      role: users.role,
      status: users.status,
      member: sql<boolean>`EXISTS (SELECT 1 FROM ${botMembers} m WHERE m.user_id = ${users.id} AND m.bot_id = ${botId})`,
    })
    .from(users)
    .orderBy(users.fullName);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    status: r.status,
    everyBot: roleWorksOnEveryBot(r.role),
    onBot: roleWorksOnEveryBot(r.role) || Boolean(r.member),
  }));
}

export async function addToBot(tx: DbOrTx, botId: string, userId: string, by: string | null) {
  await tx.insert(botMembers).values({ botId, userId, addedBy: by }).onConflictDoNothing();
}

/** Sets who works on a bot (editors and agents; admins are always on it). */
export async function setBotPeople(actor: Actor, botId: string, userIds: string[]): Promise<void> {
  const wanted = [...new Set(userIds)];
  await db.transaction(async (tx) => {
    const bot = await tx.query.bots.findFirst({
      where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
    });
    if (!bot) throw new UserError("That bot no longer exists.");
    const valid = wanted.length
      ? (
          await tx
            .select({ id: users.id })
            .from(users)
            .where(and(inArray(users.id, wanted), notInArray(users.role, [...EVERY_BOT_ROLES])))
        ).map((r) => r.id)
      : [];
    const before = (
      await tx
        .select({ userId: botMembers.userId })
        .from(botMembers)
        .innerJoin(users, eq(users.id, botMembers.userId))
        .where(and(eq(botMembers.botId, botId), notInArray(users.role, [...EVERY_BOT_ROLES])))
    ).map((r) => r.userId);
    // Admins' rows (from before they were admins) are left alone: they'd be back on it if demoted.
    const nonAdmins = tx
      .select({ id: users.id })
      .from(users)
      .where(notInArray(users.role, [...EVERY_BOT_ROLES]));
    await tx
      .delete(botMembers)
      .where(
        and(
          eq(botMembers.botId, botId),
          inArray(botMembers.userId, nonAdmins),
          valid.length ? notInArray(botMembers.userId, valid) : undefined,
        ),
      );
    for (const id of valid) await addToBot(tx, botId, id, actor.id);
    const added = valid.filter((id) => !before.includes(id)).length;
    const removed = before.filter((id) => !valid.includes(id)).length;
    if (!added && !removed) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "update",
      summary: `Changed who works on "${bot.name}": ${valid.length} ${valid.length === 1 ? "person" : "people"} (${added} added, ${removed} taken off)`,
      before: { people: before },
      after: { people: valid },
    });
  });
}

/** The bots each person works on, for Settings → Team (admins: every bot). */
export async function botsByPerson(): Promise<Map<string, { id: string; name: string }[]>> {
  const rows = await db
    .select({ userId: botMembers.userId, id: bots.id, name: bots.name })
    .from(botMembers)
    .innerJoin(bots, eq(bots.id, botMembers.botId))
    .where(isNull(bots.deletedAt))
    .orderBy(bots.name);
  const out = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    list.push({ id: r.id, name: r.name });
    out.set(r.userId, list);
  }
  return out;
}
