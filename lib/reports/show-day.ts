import "server-only";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { bots } from "@/lib/db/schema";
import { appUrl } from "@/lib/config";
import { adaptiveMessage, plainLine } from "@/lib/alerts/card";
import { hasOwnChannel, ownChannelSql, postToTeam } from "@/lib/alerts/slack-chat";
import { enqueue } from "@/lib/jobs/queue";
import { REASON_LABEL, type HandoverReason } from "@/lib/conversations/handover";
import { addDays, dayLabel, isPostDay } from "@/lib/bots/show-days";
import { londonDate } from "@/lib/time";

/**
 * The morning post in each event's Teams channel during show week: at 7:30
 * UK time on every show day (from the first day of build-up to the day
 * after breakdown), yesterday's chats and how many went to the team, why
 * they did, what's still waiting for someone right now, and what went
 * wrong: the questions Billie couldn't answer, the answers people marked
 * unhelpful and the most asked questions, each a link to fix it.
 */

export type ShowDay = {
  botName: string;
  /** The day it's posted, and the day it covers ("YYYY-MM-DD"). */
  today: string;
  day: string;
  yesterday: {
    chats: number;
    alonePct: number | null;
    handedOver: number;
    emails: number;
    requests: number;
    unhelpful: number;
  };
  /** Why chats went to the team yesterday, most first. */
  reasons: { reason: HandoverReason; n: number }[];
  waiting: { chats: number; emails: number; requests: number };
  mostAsked: { question: string; times: number }[];
  couldntAnswer: { id: string; question: string; askCount: number }[];
  unhelpful: { id: string; question: string; count: number }[];
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The card: anything people wrote goes in plain text runs, never Markdown. */
export function showDayCard(d: ShowDay, base = appUrl()) {
  const y = d.yesterday;
  const fix = `${base}/knowledge?tab=gaps`;
  const link = (text: string, url: string) => ({
    type: "Container",
    spacing: "None",
    selectAction: { type: "Action.OpenUrl", url },
    items: [plainLine(text, { spacing: "None" })],
  });
  const body: unknown[] = [
    plainLine(`${d.botName}: ${dayLabel(d.today)}`, { bold: true, size: "Medium" }),
    plainLine(`Yesterday (${dayLabel(d.day)})`, { bold: true, spacing: "Medium" }),
    plainLine(
      y.chats
        ? `${plural(y.chats, "chat", "chats")} · ${y.alonePct ?? 0}% answered by Billie alone · ${y.handedOver} passed to the team`
        : "No chats.",
      { spacing: "None" },
    ),
    plainLine(
      `${plural(y.emails, "email", "emails")} in · ${plural(y.requests, "new request", "new requests")} · ${plural(y.unhelpful, "answer", "answers")} marked unhelpful`,
      { spacing: "None" },
    ),
  ];
  if (d.reasons.length)
    body.push(
      plainLine(
        `Passed to the team: ${d.reasons.map((r) => `${REASON_LABEL[r.reason]} (${r.n})`).join(" · ")}`,
        { spacing: "None" },
      ),
    );

  const w = d.waiting;
  body.push(plainLine("Waiting now", { bold: true, spacing: "Medium" }));
  body.push(
    plainLine(
      w.chats || w.emails || w.requests
        ? [
            w.chats
              ? plural(w.chats, "chat waiting for a person", "chats waiting for a person")
              : null,
            w.emails ? plural(w.emails, "email to check", "emails to check") : null,
            w.requests ? plural(w.requests, "open request", "open requests") : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "Nothing waiting.",
      { spacing: "None" },
    ),
  );

  if (d.couldntAnswer.length || d.unhelpful.length || d.mostAsked.length)
    body.push(plainLine("To look at", { bold: true, spacing: "Medium" }));
  if (d.couldntAnswer.length) {
    body.push(plainLine("Billie couldn't answer:", { spacing: "Small" }));
    for (const g of d.couldntAnswer)
      body.push(
        link(
          `${g.question}${g.askCount > 1 ? ` (asked ${g.askCount} times)` : ""}`,
          `${fix}#gap-${g.id}`,
        ),
      );
  }
  if (d.unhelpful.length) {
    body.push(plainLine("Marked unhelpful:", { spacing: "Small" }));
    for (const u of d.unhelpful)
      body.push(
        link(
          `${u.question}${u.count > 1 ? ` (${u.count} times)` : ""}`,
          `${fix}#unhelpful-${u.id}`,
        ),
      );
  }
  if (d.mostAsked.length) {
    body.push(plainLine("Most asked:", { spacing: "Small" }));
    for (const q of d.mostAsked)
      body.push(plainLine(`${q.question} (${q.times})`, { spacing: "None" }));
  }

  const actions = [
    ...(w.chats ? [{ type: "Action.OpenUrl", title: "Open the Inbox", url: `${base}/inbox` }] : []),
    ...(w.requests
      ? [{ type: "Action.OpenUrl", title: "Open Requests", url: `${base}/requests` }]
      : []),
    ...(w.emails ? [{ type: "Action.OpenUrl", title: "Open Emails", url: `${base}/emails` }] : []),
    ...(d.couldntAnswer.length || d.unhelpful.length
      ? [{ type: "Action.OpenUrl", title: "Fix answers in Billie", url: fix }]
      : []),
  ];
  return adaptiveMessage({ body, ...(actions.length ? { actions } : {}) });
}

/** The numbers for one bot: `day` is the UK day covered, `today` the day it's posted. */
export async function showDay(botId: string, today: string): Promise<ShowDay | null> {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
    columns: { name: true },
  });
  if (!bot) return null;
  const day = addDays(today, -1);
  // UK midnights, worked out by Postgres (it knows when the clocks change).
  const from = sql`((${day})::date)::timestamp AT TIME ZONE 'Europe/London'`;
  const to = sql`((${today})::date)::timestamp AT TIME ZONE 'Europe/London'`;
  const yesterday = (col: string) => sql`${sql.raw(col)} >= ${from} AND ${sql.raw(col)} < ${to}`;

  const [n] = await query<{
    chats: number;
    handed: number;
    emails: number;
    requests: number;
    unhelpful: number;
    waiting_chats: number;
    waiting_emails: number;
    open_requests: number;
  }>(
    db,
    sql`SELECT
      (SELECT count(*)::int FROM conversations WHERE bot_id = ${botId} AND channel <> 'try' AND ${yesterday("created_at")}) AS chats,
      (SELECT count(*)::int FROM conversations WHERE bot_id = ${botId} AND channel <> 'try' AND ${yesterday("created_at")} AND handover_at IS NOT NULL) AS handed,
      (SELECT count(*)::int FROM email_threads WHERE bot_id = ${botId} AND ${yesterday("created_at")}) AS emails,
      (SELECT count(*)::int FROM chat_requests WHERE bot_id = ${botId} AND ${yesterday("created_at")}) AS requests,
      (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.bot_id = ${botId} AND c.channel <> 'try' AND m.rating = -1 AND ${yesterday("m.created_at")}) AS unhelpful,
      (SELECT count(*)::int FROM conversations WHERE bot_id = ${botId} AND status IN ('waiting', 'ticket')) AS waiting_chats,
      (SELECT count(*)::int FROM email_threads WHERE bot_id = ${botId} AND status IN ('draft_ready', 'needs_you', 'failed')) AS waiting_emails,
      (SELECT count(*)::int FROM chat_requests WHERE bot_id = ${botId} AND status IN ('new', 'in_progress')) AS open_requests`,
  );
  const [reasons, mostAsked, couldntAnswer, unhelpful] = await Promise.all([
    query<{ reason: HandoverReason; n: number }>(
      db,
      sql`SELECT handover_reason AS reason, count(*)::int AS n FROM conversations
          WHERE bot_id = ${botId} AND channel <> 'try' AND ${yesterday("created_at")}
            AND handover_at IS NOT NULL AND handover_reason IS NOT NULL
          GROUP BY 1 ORDER BY n DESC, reason`,
    ),
    query<{ question: string; times: number }>(
      db,
      sql`SELECT min(first_question) AS question, count(*)::int AS times FROM conversations
          WHERE bot_id = ${botId} AND channel <> 'try' AND first_question <> '' AND ${yesterday("created_at")}
          GROUP BY lower(regexp_replace(first_question, '[^a-zA-Z0-9 ]+', '', 'g'))
          HAVING count(*) > 1
          ORDER BY times DESC, question LIMIT 3`,
    ),
    query<{ id: string; question: string; askCount: number }>(
      db,
      sql`SELECT id, question, ask_count AS "askCount" FROM gaps
          WHERE bot_id = ${botId} AND status = 'open' AND ${yesterday("last_asked_at")}
          ORDER BY ask_count DESC, last_asked_at DESC LIMIT 3`,
    ),
    query<{ id: string; question: string; count: number }>(
      db,
      sql`SELECT id, question, count FROM unhelpful_answers
          WHERE bot_id = ${botId} AND status = 'open' AND count > 0 AND ${yesterday("last_at")}
          ORDER BY count DESC, last_at DESC LIMIT 3`,
    ),
  ]);
  return {
    botName: bot.name,
    today,
    day,
    yesterday: {
      chats: n.chats,
      alonePct: n.chats ? Math.round(((n.chats - n.handed) / n.chats) * 100) : null,
      handedOver: n.handed,
      emails: n.emails,
      requests: n.requests,
      unhelpful: n.unhelpful,
    },
    reasons,
    waiting: { chats: n.waiting_chats, emails: n.waiting_emails, requests: n.open_requests },
    mostAsked,
    couldntAnswer,
    unhelpful,
  };
}

/**
 * Each morning from 7:30 UK time: one job per bot with show days covering
 * today and its own Slack or Teams channel (queued once a day each, so a retry never
 * posts twice).
 */
export async function queueShowDays(now = new Date()): Promise<number> {
  const today = londonDate(now);
  const list = await db
    .select({ id: bots.id })
    .from(bots)
    .where(
      and(
        isNull(bots.deletedAt),
        ownChannelSql(),
        lte(bots.showStartsOn, today),
        // The day after the last one too: for breakdown day itself.
        gte(bots.showEndsOn, addDays(today, -1)),
      ),
    );
  for (const b of list)
    await enqueue(
      "show_day_post",
      { botId: b.id, today },
      { dedupeKey: `show-day:${today}:${b.id}`, once: true, maxAttempts: 3 },
    );
  return list.length;
}

/** The "show_day_post" job: one post in that event's channel. */
export async function postShowDay(botId: string, today: string): Promise<void> {
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, botId) });
  if (!bot || bot.deletedAt || !hasOwnChannel(bot)) return;
  // The days may have changed since it was queued.
  const days =
    bot.showStartsOn && bot.showEndsOn ? { from: bot.showStartsOn, to: bot.showEndsOn } : null;
  if (!isPostDay(days, today)) return;
  const d = await showDay(botId, today);
  if (d)
    await postToTeam({
      botId,
      teamsLink: bot.teamsWebhookUrl,
      message: showDayCard(d),
      ownOnly: true,
    });
}
