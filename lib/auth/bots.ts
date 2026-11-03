import "server-only";
import { cache } from "react";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import {
  botMembers,
  bots,
  chatRequests,
  conversations,
  deadlines,
  emailThreads,
  gaps,
  knowledgeBases,
  reminderBatches,
  sources,
  unhelpfulAnswers,
  users,
  websites,
} from "@/lib/db/schema";
import {
  botScopeOf,
  canOnBot,
  EVERY_BOT_ROLES,
  scopeIds,
  worksOnEveryBot,
  type Action,
  type Actor,
  type BotScope,
} from "@/lib/authz";
import { UserError } from "@/lib/errors";

/**
 * Who works on which bot (bot_members), for the checks in lib/authz.ts.
 * Pages and actions ask botScope() for the list and assertOnBot() before
 * touching anything that belongs to a bot. Admins work on every bot.
 */

export class NotOnBotError extends UserError {
  constructor() {
    super("You don't work on this bot. An admin can add you on the bot's People step.");
  }
}

/** The bots the actor works on (once per request). */
export const botScope = cache(async (actor: Actor): Promise<BotScope> => {
  if (worksOnEveryBot(actor)) return { all: true };
  const rows = await db
    .select({ botId: botMembers.botId })
    .from(botMembers)
    .where(eq(botMembers.userId, actor.id));
  return botScopeOf(
    actor,
    rows.map((r) => r.botId),
  );
});

/** Ids of the actor's bots for a query; null means every bot. */
export async function myBotIds(actor: Actor): Promise<string[] | null> {
  return scopeIds(await botScope(actor));
}

/** A SQL condition: the column is one of these bots (always true for every bot). */
export function inBots(ids: string[] | null, column: AnyPgColumn | SQL): SQL {
  if (ids === null) return sql`TRUE`;
  if (!ids.length) return sql`FALSE`;
  return sql`${column} IN ${ids}`;
}

/** Which bots a list shows: the actor's bots (null is every bot), and maybe just one of them. */
export type BotView = { ids: string[] | null; only?: string | null };

/** A SQL condition for a list: the actor's bots, narrowed to one when they picked one. */
export function inView(view: BotView, column: AnyPgColumn | SQL): SQL {
  const mine = inBots(view.ids, column);
  return view.only ? sql`(${mine} AND ${column} = ${view.only})` : mine;
}

/** The actor's bots, and the one picked in ?bot= if it's one of theirs. */
export async function botView(actor: Actor, picked?: string | null): Promise<BotView> {
  const ids = await myBotIds(actor);
  const only =
    picked && /^[0-9a-f-]{36}$/i.test(picked) && (ids === null || ids.includes(picked))
      ? picked
      : null;
  return { ids, only };
}

/** Throws unless the actor may do this to something of this bot. */
export async function assertOnBot(
  actor: Actor,
  action: Action,
  botId: string | null | undefined,
): Promise<void> {
  if (!canOnBot(actor, action, await botScope(actor), botId)) throw new NotOnBotError();
}

/** May the actor do this on this bot? (For pages: what to show.) */
export async function mayOnBot(
  actor: Actor,
  action: Action,
  botId: string | null | undefined,
): Promise<boolean> {
  return canOnBot(actor, action, await botScope(actor), botId);
}

/** The bot a chat, request, email, unanswered question, knowledge or deadline belongs to. */
export async function botOf(
  kind:
    | "conversation"
    | "request"
    | "email"
    | "gap"
    | "unhelpful"
    | "kb"
    | "source"
    | "deadline"
    | "reminders"
    | "website",
  id: string,
): Promise<string | null> {
  switch (kind) {
    case "website": {
      const [row] = await db
        .select({ botId: knowledgeBases.botId })
        .from(websites)
        .innerJoin(knowledgeBases, eq(knowledgeBases.id, websites.knowledgeBaseId))
        .where(eq(websites.id, id));
      return row?.botId ?? null;
    }
    case "unhelpful":
      return (
        (
          await db.query.unhelpfulAnswers.findFirst({
            where: eq(unhelpfulAnswers.id, id),
            columns: { botId: true },
          })
        )?.botId ?? null
      );
    case "deadline":
      return (
        (
          await db.query.deadlines.findFirst({
            where: eq(deadlines.id, id),
            columns: { botId: true },
          })
        )?.botId ?? null
      );
    case "reminders":
      return (
        (
          await db.query.reminderBatches.findFirst({
            where: eq(reminderBatches.id, id),
            columns: { botId: true },
          })
        )?.botId ?? null
      );
    case "conversation":
      return (
        (
          await db.query.conversations.findFirst({
            where: eq(conversations.id, id),
            columns: { botId: true },
          })
        )?.botId ?? null
      );
    case "request":
      return (
        (
          await db.query.chatRequests.findFirst({
            where: eq(chatRequests.id, id),
            columns: { botId: true },
          })
        )?.botId ?? null
      );
    case "email":
      return (
        (
          await db.query.emailThreads.findFirst({
            where: eq(emailThreads.id, id),
            columns: { botId: true },
          })
        )?.botId ?? null
      );
    case "gap":
      return (
        (await db.query.gaps.findFirst({ where: eq(gaps.id, id), columns: { botId: true } }))
          ?.botId ?? null
      );
    case "kb":
      return (
        (
          await db.query.knowledgeBases.findFirst({
            where: eq(knowledgeBases.id, id),
            columns: { botId: true },
          })
        )?.botId ?? null
      );
    case "source": {
      const [row] = await db
        .select({ botId: knowledgeBases.botId })
        .from(sources)
        .innerJoin(knowledgeBases, eq(knowledgeBases.id, sources.knowledgeBaseId))
        .where(eq(sources.id, id));
      return row?.botId ?? null;
    }
  }
}

/** Checks the actor may do this to that thing, through the bot it belongs to. */
export async function assertOnBotOf(
  actor: Actor,
  action: Action,
  kind: Parameters<typeof botOf>[0],
  id: string,
): Promise<void> {
  const scope = await botScope(actor);
  // Every bot: no need to look the bot up.
  const botId = scope.all ? null : await botOf(kind, id);
  if (!canOnBot(actor, action, scope, botId)) throw new NotOnBotError();
}

/** SQL: the user (users table) works on this bot, as a member or by role. */
export function worksOnBotSql(botId: string): SQL {
  return sql`(${inArray(users.role, [...EVERY_BOT_ROLES])} OR EXISTS (SELECT 1 FROM ${botMembers} m WHERE m.user_id = ${users.id} AND m.bot_id = ${botId}))`;
}

/**
 * Active people who work on a bot: its members, and admins (who work on
 * every bot). For "Handled by" lists and Teams messages.
 */
export async function peopleOnBot(
  botId: string,
): Promise<{ id: string; name: string; email: string; role: Actor["role"] }[]> {
  return db
    .select({ id: users.id, name: users.fullName, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.status, "active"), worksOnBotSql(botId)))
    .orderBy(users.fullName);
}

/** Keeps only the people (by id) who work on the bot: a Teams message they couldn't open is no use. */
export async function onlyPeopleOnBot<T extends { id: string }>(
  botId: string,
  people: T[],
): Promise<T[]> {
  if (!people.length) return people;
  const ok = new Set(
    (
      await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            inArray(
              users.id,
              people.map((p) => p.id),
            ),
            worksOnBotSql(botId),
          ),
        )
    ).map((r) => r.id),
  );
  return people.filter((p) => ok.has(p.id));
}

/** Live bots' ids the actor works on, for pickers (bots in the bin left out). */
export async function myBots(actor: Actor): Promise<{ id: string; name: string }[]> {
  const ids = await myBotIds(actor);
  if (ids && !ids.length) return [];
  return db
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(and(isNull(bots.deletedAt), ids ? inArray(bots.id, ids) : undefined))
    .orderBy(bots.name);
}
