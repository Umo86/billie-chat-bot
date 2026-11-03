import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, conversations, messages, users } from "@/lib/db/schema";
import { worksOnBotSql } from "@/lib/auth/bots";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";
import { matchRoute, MAX_ROUTES, type HandoverRoute } from "./routes";

/**
 * Who handles what, on the server: the person a chat or an email about a
 * topic goes to first. Only someone still active and working on the bot;
 * otherwise nobody (and the usual people are told).
 */

export type Routed = { userId: string; email: string; name: string; topic: string };

export async function routeFor(botId: string, texts: string[]): Promise<Routed | null> {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
    columns: { routes: true },
  });
  const route = bot ? matchRoute(bot.routes, texts) : null;
  if (!route) return null;
  const [person] = await db
    .select({ id: users.id, email: users.email, name: users.fullName })
    .from(users)
    .where(and(eq(users.id, route.userId), eq(users.status, "active"), worksOnBotSql(botId)));
  return person
    ? {
        userId: person.id,
        email: person.email,
        name: person.name || person.email,
        topic: route.topic,
      }
    : null;
}

/** What a chat's visitor has written, latest first (what a route matches against). */
export async function visitorWords(conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ text: messages.text })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "visitor")))
    .orderBy(desc(messages.createdAt))
    .limit(10);
  return rows.map((r) => r.text);
}

/** Gives an unassigned chat to the person who handles its topic. */
export async function assignByRoute(conversationId: string, r: Routed): Promise<void> {
  await db.transaction(async (tx) => {
    const [c] = await tx
      .update(conversations)
      .set({ assignedTo: r.userId })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.assignedTo)))
      .returning({ id: conversations.id });
    if (!c) return;
    await writeAudit(tx, {
      actorType: "system",
      entityType: "conversation",
      entityId: conversationId,
      action: "update",
      summary: `Gave the chat to the person who handles ${r.topic}`,
    });
  });
}

/** Saves a bot's "who handles what": each person must work on the bot. */
export async function saveRoutes(
  actor: Actor,
  botId: string,
  routes: HandoverRoute[],
): Promise<void> {
  const list = routes.slice(0, MAX_ROUTES);
  await db.transaction(async (tx) => {
    const [bot] = await tx
      .select({ id: bots.id, name: bots.name })
      .from(bots)
      .where(and(eq(bots.id, botId), isNull(bots.deletedAt)))
      .for("update");
    if (!bot) throw new UserError("That bot no longer exists.");
    const ids = [...new Set(list.map((r) => r.userId))];
    const onBot = ids.length
      ? (
          await tx
            .select({ id: users.id })
            .from(users)
            .where(and(inArray(users.id, ids), eq(users.status, "active"), worksOnBotSql(botId)))
        ).map((u) => u.id)
      : [];
    const missing = list.find((r) => !onBot.includes(r.userId));
    if (missing)
      throw new UserError(
        `Choose someone who works on this bot for "${missing.topic}" (add them above first).`,
      );
    await tx.update(bots).set({ routes: list }).where(eq(bots.id, botId));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "update",
      summary: list.length
        ? `Set who handles what on "${bot.name}": ${list.map((r) => r.topic).join(", ")}`.slice(
            0,
            300,
          )
        : `Removed who handles what on "${bot.name}"`,
    });
  });
}
