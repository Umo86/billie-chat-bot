import "server-only";
import { worksOnBotSql } from "@/lib/auth/bots";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentPresence, users } from "@/lib/db/schema";

/**
 * Who is answering live chats. Switching "Available" on lasts 8 hours and
 * is extended while that person's Inbox is open; switching off ends it.
 */
export const AVAILABLE_HOURS = 8;

export async function setAvailable(
  userId: string,
  available: boolean,
  now = new Date(),
): Promise<void> {
  const until = available ? new Date(now.getTime() + AVAILABLE_HOURS * 3_600_000) : null;
  await db
    .insert(agentPresence)
    .values({ userId, availableUntil: until, updatedAt: now })
    .onConflictDoUpdate({
      target: agentPresence.userId,
      set: { availableUntil: until, updatedAt: now },
    });
}

/** Keeps an available person available while their Inbox is open (no effect when they're off). */
export async function extendIfAvailable(userId: string, now = new Date()): Promise<void> {
  const until = new Date(now.getTime() + AVAILABLE_HOURS * 3_600_000);
  await db
    .update(agentPresence)
    .set({ availableUntil: until, updatedAt: now })
    .where(and(eq(agentPresence.userId, userId), gt(agentPresence.availableUntil, now)));
}

export async function isAvailable(userId: string, now = new Date()): Promise<boolean> {
  const row = await db.query.agentPresence.findFirst({ where: eq(agentPresence.userId, userId) });
  return Boolean(row?.availableUntil && row.availableUntil > now);
}

/**
 * Active team members marked available right now; with a bot, only those
 * who work on it (nobody else can see its chats).
 */
export async function agentsAvailable(now = new Date(), botId?: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentPresence)
    .innerJoin(users, eq(users.id, agentPresence.userId))
    .where(
      and(
        gt(agentPresence.availableUntil, now),
        eq(users.status, "active"),
        botId ? worksOnBotSql(botId) : undefined,
      ),
    );
  return rows[0]?.n ?? 0;
}
