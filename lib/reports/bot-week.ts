import "server-only";
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, conversations, gaps } from "@/lib/db/schema";
import { appUrl } from "@/lib/config";
import { getSettings } from "@/lib/settings";
import { adaptiveMessage, plainLine } from "@/lib/alerts/card";
import { hasOwnChannel, ownChannelSql, postToTeam } from "@/lib/alerts/slack-chat";
import { enqueue } from "@/lib/jobs/queue";
import { kpis, topQuestions, type Kpis } from "./queries";

/**
 * The Monday post in each event's Teams channel: last week's chats, how
 * many Billie answered alone, emails drafted, the most asked questions,
 * new questions it couldn't answer (each a link to answer it) and an
 * estimate of the hours saved. So the knowledge keeps getting better
 * without anyone remembering to open Reports.
 */

/** What we count a chat Billie answered alone, and an email it drafted, as saving. */
export const MINUTES_SAVED = { chat: 4, email: 8 } as const;

/** Hours saved, to the nearest half hour. */
export function hoursSaved(chatsAlone: number, emailsDrafted: number): number {
  const minutes = chatsAlone * MINUTES_SAVED.chat + emailsDrafted * MINUTES_SAVED.email;
  return Math.round((minutes / 60) * 2) / 2;
}

export type BotWeek = {
  botName: string;
  k: Kpis;
  top: { question: string; times: number }[];
  newGaps: { id: string; question: string; askCount: number }[];
  hours: number;
  link: string;
  gapsLink: string;
};

/** The card: anything people wrote goes in plain text runs, never Markdown. */
export function botWeekCard(w: BotWeek) {
  const pct = w.k.answeredAlonePct === null ? "–" : `${w.k.answeredAlonePct}%`;
  const body: unknown[] = [
    plainLine(`${w.botName}: last week`, { bold: true, size: "Medium" }),
    plainLine(
      `${w.k.chats} ${w.k.chats === 1 ? "chat" : "chats"} · ${pct} answered by Billie alone · ${w.k.handedOver} passed to the team · ${w.k.emailsDrafted} email ${w.k.emailsDrafted === 1 ? "reply" : "replies"} drafted`,
      { spacing: "None" },
    ),
    plainLine(
      `About ${w.hours} ${w.hours === 1 ? "hour" : "hours"} saved (we count ${MINUTES_SAVED.chat} minutes for each chat Billie answered alone and ${MINUTES_SAVED.email} for each email it drafted).`,
    ),
  ];
  if (w.top.length) {
    body.push(plainLine("Most asked", { bold: true, spacing: "Medium" }));
    for (const q of w.top) body.push(plainLine(`${q.question} (${q.times})`, { spacing: "None" }));
  }
  if (w.newGaps.length) {
    body.push(plainLine("New questions Billie couldn't answer", { bold: true, spacing: "Medium" }));
    for (const g of w.newGaps)
      body.push({
        type: "Container",
        spacing: "None",
        selectAction: { type: "Action.OpenUrl", url: `${w.gapsLink}#gap-${g.id}` },
        items: [
          plainLine(`${g.question}${g.askCount > 1 ? ` (asked ${g.askCount} times)` : ""}`, {
            spacing: "None",
          }),
        ],
      });
  }
  return adaptiveMessage({
    body,
    actions: [
      ...(w.newGaps.length
        ? [{ type: "Action.OpenUrl", title: "Answer them in Billie", url: w.gapsLink }]
        : []),
      { type: "Action.OpenUrl", title: "Open Reports", url: w.link },
    ],
  });
}

export async function botWeek(botId: string, now = new Date()): Promise<BotWeek | null> {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
  });
  if (!bot) return null;
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [k, top, newGaps] = await Promise.all([
    kpis(since, [botId]),
    topQuestions(since, 5, [botId]),
    db
      .select({ id: gaps.id, question: gaps.question, askCount: gaps.askCount })
      .from(gaps)
      .where(and(eq(gaps.botId, botId), eq(gaps.status, "open"), gte(gaps.firstAskedAt, since)))
      .orderBy(desc(gaps.askCount), desc(gaps.lastAskedAt))
      .limit(5),
  ]);
  return {
    botName: bot.name,
    k,
    top,
    newGaps,
    hours: hoursSaved(k.chats - k.handedOver, k.emailsDrafted),
    link: `${appUrl()}/reports?days=7`,
    gapsLink: `${appUrl()}/knowledge?tab=gaps`,
  };
}

/**
 * Mondays: one job per bot with its own Slack or Teams channel that is live or had
 * chats last week (queued once a day, so a retry never posts twice).
 */
export async function queueBotWeeks(now = new Date()): Promise<number> {
  const s = await getSettings();
  if (!s.weeklySummary) return 0;
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const list = await db
    .select({ id: bots.id })
    .from(bots)
    .where(
      and(
        isNull(bots.deletedAt),
        ownChannelSql(),
        or(
          eq(bots.status, "live"),
          sql`EXISTS (SELECT 1 FROM ${conversations} c WHERE c.bot_id = ${bots.id} AND c.channel <> 'try' AND c.created_at >= ${since.toISOString()})`,
        ),
      ),
    );
  const day = now.toISOString().slice(0, 10);
  for (const b of list)
    await enqueue(
      "weekly_bot_summary",
      { botId: b.id },
      { dedupeKey: `bot-week:${day}:${b.id}`, once: true, maxAttempts: 3 },
    );
  return list.length;
}

/** The "weekly_bot_summary" job: one post in that event's channel. */
export async function postBotWeek(botId: string, now = new Date()): Promise<void> {
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, botId) });
  if (!bot || bot.deletedAt || !hasOwnChannel(bot)) return;
  const week = await botWeek(botId, now);
  if (week)
    await postToTeam({
      botId,
      teamsLink: bot.teamsWebhookUrl,
      message: botWeekCard(week),
      ownOnly: true,
    });
}
