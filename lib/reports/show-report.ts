import "server-only";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { aiUsage, bots } from "@/lib/db/schema";
import { REASON_LABEL, type HandoverReason } from "@/lib/conversations/handover";
import { addDays, daysInclusive, isDay } from "@/lib/bots/show-days";
import { londonDate } from "@/lib/time";
import { hoursSaved } from "./bot-week";

/**
 * One bot's end-of-show report, for its show days (build-up to breakdown):
 * chats and emails, the share Billie answered alone, hours saved, what
 * Claude cost a chat, the most asked questions, why chats went to the team,
 * and what to fix before the next show. The page and the PDF both use it.
 */

/** A report covers at most this many days (a show, or a few weeks either side). */
export const REPORT_DAYS_MAX = 120;

export type ShowReport = {
  botId: string;
  botName: string;
  showName: string;
  from: string;
  to: string;
  /** The bot's own show days, or a stand-in range when it has none. */
  usesShowDays: boolean;
  chats: number;
  alonePct: number | null;
  handedOver: number;
  whatsapp: number;
  emails: number;
  emailsDrafted: number;
  requests: number;
  helpfulPct: number | null;
  hours: number;
  /** Claude's cost for the bot's chat answers (null: not shown to this person). */
  costMicros: number | null;
  costPerChatMicros: number | null;
  days: { day: string; chats: number; handedOver: number }[];
  mostAsked: { question: string; times: number }[];
  reasons: { label: string; n: number }[];
  requestsByType: { name: string; n: number }[];
  couldntAnswer: { id: string; question: string; askCount: number }[];
  unhelpful: { id: string; question: string; count: number }[];
};

/** The days a report covers: asked for, else the bot's show days, else the last 30. */
export function reportRange(
  bot: { showStartsOn: string | null; showEndsOn: string | null },
  asked: { from?: string; to?: string },
  today = londonDate(),
): { from: string; to: string; usesShowDays: boolean } {
  if (asked.from && asked.to && isDay(asked.from) && isDay(asked.to) && asked.from <= asked.to) {
    const to =
      daysInclusive(asked.from, asked.to) > REPORT_DAYS_MAX
        ? addDays(asked.from, REPORT_DAYS_MAX - 1)
        : asked.to;
    return { from: asked.from, to, usesShowDays: false };
  }
  if (bot.showStartsOn && bot.showEndsOn)
    return { from: bot.showStartsOn, to: bot.showEndsOn, usesShowDays: true };
  return { from: addDays(today, -29), to: today, usesShowDays: false };
}

export async function showReport(
  botId: string,
  range: { from: string; to: string; usesShowDays: boolean },
  opts: { withCost: boolean },
): Promise<ShowReport | null> {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
    columns: { name: true, showName: true },
  });
  if (!bot) return null;
  const { from, to } = range;
  // UK midnights, worked out by Postgres (it knows when the clocks change).
  const start = sql`((${from})::date)::timestamp AT TIME ZONE 'Europe/London'`;
  const end = sql`((${addDays(to, 1)})::date)::timestamp AT TIME ZONE 'Europe/London'`;
  const within = (col: string) => sql`${sql.raw(col)} >= ${start} AND ${sql.raw(col)} < ${end}`;

  const [n] = await query<{
    chats: number;
    handed: number;
    whatsapp: number;
    emails: number;
    drafted: number;
    requests: number;
    up: number;
    down: number;
  }>(
    db,
    sql`SELECT
      (SELECT count(*)::int FROM conversations WHERE bot_id = ${botId} AND channel <> 'try' AND ${within("created_at")}) AS chats,
      (SELECT count(*)::int FROM conversations WHERE bot_id = ${botId} AND channel <> 'try' AND ${within("created_at")} AND handover_at IS NOT NULL) AS handed,
      (SELECT count(*)::int FROM conversations WHERE bot_id = ${botId} AND channel = 'whatsapp' AND ${within("created_at")}) AS whatsapp,
      (SELECT count(*)::int FROM email_threads WHERE bot_id = ${botId} AND ${within("created_at")}) AS emails,
      (SELECT count(*)::int FROM email_threads WHERE bot_id = ${botId} AND ${within("created_at")} AND status IN ('draft_ready', 'sent')) AS drafted,
      (SELECT count(*)::int FROM chat_requests WHERE bot_id = ${botId} AND ${within("created_at")}) AS requests,
      (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.bot_id = ${botId} AND c.channel <> 'try' AND m.rating = 1 AND ${within("m.created_at")}) AS up,
      (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.bot_id = ${botId} AND c.channel <> 'try' AND m.rating = -1 AND ${within("m.created_at")}) AS down`,
  );
  const [days, mostAsked, reasons, requestsByType, couldntAnswer, unhelpful, cost] =
    await Promise.all([
      query<{ day: string; chats: number; handed: number }>(
        db,
        sql`SELECT to_char(created_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS day,
                   count(*)::int AS chats,
                   count(*) FILTER (WHERE handover_at IS NOT NULL)::int AS handed
            FROM conversations
            WHERE bot_id = ${botId} AND channel <> 'try' AND ${within("created_at")}
            GROUP BY 1 ORDER BY 1`,
      ),
      query<{ question: string; times: number }>(
        db,
        sql`SELECT min(first_question) AS question, count(*)::int AS times FROM conversations
            WHERE bot_id = ${botId} AND channel <> 'try' AND first_question <> '' AND ${within("created_at")}
            GROUP BY lower(regexp_replace(first_question, '[^a-zA-Z0-9 ]+', '', 'g'))
            ORDER BY times DESC, question LIMIT 10`,
      ),
      query<{ reason: HandoverReason; n: number }>(
        db,
        sql`SELECT handover_reason AS reason, count(*)::int AS n FROM conversations
            WHERE bot_id = ${botId} AND channel <> 'try' AND ${within("created_at")}
              AND handover_at IS NOT NULL AND handover_reason IS NOT NULL
            GROUP BY 1 ORDER BY n DESC, reason`,
      ),
      query<{ name: string; n: number }>(
        db,
        sql`SELECT type_name AS name, count(*)::int AS n FROM chat_requests
            WHERE bot_id = ${botId} AND ${within("created_at")}
            GROUP BY 1 ORDER BY n DESC, name LIMIT 10`,
      ),
      query<{ id: string; question: string; askCount: number }>(
        db,
        sql`SELECT id, question, ask_count AS "askCount" FROM gaps
            WHERE bot_id = ${botId} AND status = 'open' AND ${within("last_asked_at")}
            ORDER BY ask_count DESC, last_asked_at DESC LIMIT 10`,
      ),
      query<{ id: string; question: string; count: number }>(
        db,
        sql`SELECT id, question, count FROM unhelpful_answers
            WHERE bot_id = ${botId} AND status = 'open' AND count > 0 AND ${within("last_at")}
            ORDER BY count DESC, last_at DESC LIMIT 10`,
      ),
      opts.withCost
        ? db
            .select({ micros: sql<string>`coalesce(sum(${aiUsage.costMicros}), 0)` })
            .from(aiUsage)
            .where(
              and(eq(aiUsage.scope, `bot:${botId}`), gte(aiUsage.day, from), lte(aiUsage.day, to)),
            )
        : Promise.resolve(null),
    ]);
  const costMicros = cost ? Number(cost[0]?.micros ?? 0) : null;
  const alone = n.chats - n.handed;
  return {
    botId,
    botName: bot.name,
    showName: bot.showName,
    from,
    to,
    usesShowDays: range.usesShowDays,
    chats: n.chats,
    alonePct: n.chats ? Math.round((alone / n.chats) * 100) : null,
    handedOver: n.handed,
    whatsapp: n.whatsapp,
    emails: n.emails,
    emailsDrafted: n.drafted,
    requests: n.requests,
    helpfulPct: n.up + n.down ? Math.round((n.up / (n.up + n.down)) * 100) : null,
    hours: hoursSaved(alone, n.drafted),
    costMicros,
    costPerChatMicros: costMicros !== null && n.chats ? Math.round(costMicros / n.chats) : null,
    days: days.map((d) => ({ day: d.day, chats: d.chats, handedOver: d.handed })),
    mostAsked,
    reasons: reasons.map((r) => ({ label: REASON_LABEL[r.reason] ?? r.reason, n: r.n })),
    requestsByType,
    couldntAnswer,
    unhelpful,
  };
}
