import "server-only";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { microsoftConfigured } from "@/lib/config";
import { londonParts } from "@/lib/time";
import { enqueue, pruneJobs, runDueJobs, type Handlers } from "./queue";

/**
 * The job handlers, in one place. Modules load lazily so a job only pulls
 * in what it needs (a WhatsApp message doesn't load the PDF reader).
 */
const handlers: Handlers = {
  ingest_source: async (p) =>
    (await import("@/lib/knowledge/ingest")).ingestSource(String(p.sourceId)),
  knowledge_check: async (p, job) =>
    (await import("@/lib/knowledge/check")).runKnowledgeCheck(String(p.checkId), {
      lastTry: job.attempts >= job.maxAttempts,
    }),
  suggest_reply: async (p, job) =>
    (await import("@/lib/conversations/suggest")).writeSuggestion(String(p.conversationId), {
      lastTry: job.attempts >= job.maxAttempts,
    }),
  notify_handover: async (p) =>
    (await import("@/lib/alerts/notify")).notifyHandover(
      String(p.conversationId),
      p.kind === "ticket" ? "ticket" : "live",
    ),
  alert_email: async (p) =>
    (await import("@/lib/alerts/notify")).sendAlertEmail(
      String(p.conversationId),
      p.kind === "ticket" ? "ticket" : "live",
    ),
  teams_direct: async (p) => (await import("@/lib/alerts/direct")).sendDirect(String(p.to), p.card),
  slack_direct: async (p) =>
    (await import("@/lib/alerts/slack-chat")).sendSlackDirect(String(p.to), p.card),
  slack_relay: async (p) =>
    (await import("@/lib/alerts/slack-chat")).relayToSlack(String(p.messageId)),
  slack_note: async (p) =>
    (await import("@/lib/alerts/slack-chat")).noteInSlack(String(p.conversationId), String(p.text)),
  slack_event: async (p) =>
    (await import("@/lib/alerts/slack-chat")).handleThreadReply({
      channel: String(p.channel),
      threadTs: String(p.threadTs),
      ts: String(p.ts),
      user: String(p.user),
      text: String(p.text),
    }),
  slack_action: async (p) =>
    (await import("@/lib/alerts/slack-chat")).handleSlackAction({
      action: String(p.action),
      conversationId: String(p.conversationId),
      user: String(p.user),
      channel: String(p.channel),
      ts: String(p.ts),
      threadTs: typeof p.threadTs === "string" ? p.threadTs : undefined,
    }),
  slack_email_digest: async (p) =>
    (await import("@/lib/emails/slack-digest")).postEmailDigest(String(p.botId)),
  expire_waiting: async () => {
    await (await import("@/lib/conversations/service")).expireWaiting();
  },
  notify_request: async (p) =>
    (await import("@/lib/requests/service")).notifyRequest(String(p.requestId)),
  send_request_update: async (p) => {
    const { sendRequestUpdate } = await import("@/lib/requests/service");
    const status = ["new", "in_progress", "done", "declined"].includes(String(p.status))
      ? (p.status as "new" | "in_progress" | "done" | "declined")
      : undefined;
    await sendRequestUpdate(String(p.requestId), {
      status,
      note: typeof p.note === "string" ? p.note : undefined,
    });
  },
  send_staff_reply: async (p) =>
    (await import("@/lib/conversations/delivery")).deliverStaffReply(
      String(p.messageId),
      p.via === "whatsapp" ? "whatsapp" : "email",
    ),
  whatsapp_inbound: async (p) => {
    const { handleWhatsAppInbound } = await import("@/lib/channels/whatsapp-inbound");
    const m = p.message as {
      id: string;
      from: string;
      profileName: string;
      timestamp: string;
      text: string;
      buttonId: string | null;
    };
    await handleWhatsAppInbound({ ...m, timestamp: new Date(m.timestamp) });
  },
  process_email: async (p) =>
    (await import("@/lib/emails/process")).processEmail(String(p.emailId), {
      redo: p.redo === true,
    }),
  deliver_email_draft: async (p, job) =>
    (await import("@/lib/emails/deliver")).deliverEmailDraft(String(p.emailId), {
      quiet: p.quiet === true,
      lastTry: job.attempts >= job.maxAttempts,
    }),
  outlook_sent_check: async () => {
    await (await import("@/lib/emails/learn")).checkSentDrafts();
  },
  learn_from_sent: async (p) =>
    (await import("@/lib/emails/learn")).learnFromSent(String(p.emailId)),
  outlook_sync: async () => {
    await (await import("@/lib/channels/outlook")).syncAllMailboxes();
  },
  refresh_web_sources: async () => {
    await queueWebRefresh();
    // Whole websites: looked at again weekly (new pages added, gone ones taken out).
    await (await import("@/lib/knowledge/websites")).queueWebsiteRecrawls();
  },
  email_history: async (p, job) => {
    await (
      await import("@/lib/emails/history")
    ).readHistory(String(p.botId), Number(p.months) || 12, {
      lastTry: job.attempts >= job.maxAttempts,
    });
  },
  crm_lead: async (p, job) =>
    (await import("@/lib/crm/leads")).sendLead(String(p.requestId), {
      lastTry: job.attempts >= job.maxAttempts,
    }),
  crawl_website: async (p) => {
    await (
      await import("@/lib/knowledge/websites")
    ).crawlWebsite(String(p.websiteId), new Date(), { all: p.all === true });
  },
  retention: async () => {
    await (await import("@/lib/privacy/retention")).runRetention();
  },
  nudge_waiting: async () => {
    await (await import("@/lib/alerts/nudge")).runNudges();
  },
  weekly_summary: async () => {
    // Each event's own channel first (queued once each), then the company email.
    await (await import("@/lib/reports/bot-week")).queueBotWeeks();
    await (await import("@/lib/reports/summary")).sendWeeklySummary();
  },
  weekly_bot_summary: async (p) => {
    await (await import("@/lib/reports/bot-week")).postBotWeek(String(p.botId));
  },
  deadline_reminders: async () => {
    await (await import("@/lib/exhibitors/deadlines")).startScheduledReminders();
  },
  draft_reminders: async (p, job) =>
    (await import("@/lib/exhibitors/reminders")).writeReminders(String(p.batchId), {
      lastTry: job.attempts >= job.maxAttempts,
    }),
  budget_check: async () => {
    await (await import("@/lib/ai/budget")).checkBudget();
  },
  show_days: async () => {
    await (await import("@/lib/reports/show-day")).queueShowDays();
  },
  show_day_post: async (p) => {
    await (await import("@/lib/reports/show-day")).postShowDay(String(p.botId), String(p.today));
  },
  send_reminders: async (p) => {
    await (
      await import("@/lib/exhibitors/reminders")
    ).sendReminderBatch(String(p.batchId), { round: Number(p.round) || 1 });
  },
};

export function runJobsNow(opts: { budgetMs?: number; long?: boolean } = {}) {
  return runDueJobs(handlers, opts);
}

/** Web pages marked "re-read weekly" whose last read is over 7 days old. */
export async function queueWebRefresh(now = new Date()): Promise<number> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const due = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.kind, "web"),
        eq(sources.refreshWeekly, true),
        isNull(sources.deletedAt),
        or(isNull(sources.lastReadAt), lt(sources.lastReadAt, weekAgo)),
      ),
    )
    .limit(200);
  for (const s of due)
    await enqueue("ingest_source", { sourceId: s.id }, { dedupeKey: `ingest:${s.id}` });
  return due.length;
}

/**
 * Once a minute (Vercel Cron). The sweep of the event mailboxes is queued
 * here so it runs once however many instances call, and only when
 * Microsoft 365 is connected and a bot has a mailbox switched on.
 */
export async function minuteTick(now = new Date()) {
  const minute = Math.floor(now.getTime() / 60_000);
  if (microsoftConfigured()) {
    const { hasMailboxToSync } = await import("@/lib/channels/outlook");
    if (await hasMailboxToSync()) {
      await enqueue("outlook_sync", {}, { dedupeKey: `outlook:${minute}`, maxAttempts: 1 });
      // Every ten minutes: Billie's drafts the team has sent (or deleted) since.
      const { hasDraftsToCheck } = await import("@/lib/emails/learn");
      if (await hasDraftsToCheck(now))
        await enqueue(
          "outlook_sent_check",
          {},
          { dedupeKey: `sent-check:${Math.floor(minute / 10)}`, once: true, maxAttempts: 1 },
        );
    }
  }
  // Once a day, from 08:00 UK time: deadline reminders whose day has come.
  const uk = londonParts(now);
  if (uk.minutes >= 8 * 60)
    await enqueue(
      "deadline_reminders",
      {},
      { dedupeKey: `deadlines:${uk.date}`, once: true, maxAttempts: 2 },
    );
  // Show week, from 07:30 UK time: the morning post in each event's channel.
  if (uk.minutes >= 7 * 60 + 30)
    await enqueue(
      "show_days",
      {},
      { dedupeKey: `show-days:${uk.date}`, once: true, maxAttempts: 2 },
    );
  // Live chats nobody has answered in five minutes: Billie takes their details instead.
  const { hasExpiredWaiting } = await import("@/lib/conversations/service");
  if (await hasExpiredWaiting(now))
    await enqueue(
      "expire_waiting",
      {},
      { dedupeKey: `expire-waiting:${minute}`, once: true, maxAttempts: 1 },
    );
  // Every 15 minutes: Teams nudges about chats and emails still waiting for a reply,
  // and a look at the month's Claude spend against the budget.
  await enqueue(
    "nudge_waiting",
    {},
    { dedupeKey: `nudge:${Math.floor(minute / 15)}`, once: true, maxAttempts: 1 },
  );
  await enqueue(
    "budget_check",
    {},
    { dedupeKey: `budget:${Math.floor(minute / 15)}`, once: true, maxAttempts: 1 },
  );
  // The sweep's function has five minutes, so it also takes the long jobs.
  return runJobsNow({ budgetMs: 50_000, long: true });
}

/** Once a day (Vercel Cron). */
export async function dailyTick(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  await enqueue("retention", {}, { dedupeKey: `retention:${day}` });
  await enqueue("refresh_web_sources", {}, { dedupeKey: `web:${day}` });
  // Mondays (UK): last week's summary.
  if (
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(
      now,
    ) === "Mon"
  ) {
    await enqueue("weekly_summary", {}, { dedupeKey: `summary:${day}` });
  }
  const pruned = await pruneJobs(now);
  const { pruneRateLimits } = await import("@/lib/rate-limit");
  const limits = await pruneRateLimits(now.getTime());
  const ran = await runJobsNow({ budgetMs: 200_000, long: true });
  return { pruned, limits, ...ran, at: now.toISOString() };
}
