import "server-only";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { enqueue, pruneJobs, runDueJobs, type Handlers } from "./queue";

/**
 * The job handlers, in one place. Modules load lazily so a job only pulls
 * in what it needs (a WhatsApp message doesn't load the PDF reader).
 */
const handlers: Handlers = {
  ingest_source: async (p) =>
    (await import("@/lib/knowledge/ingest")).ingestSource(String(p.sourceId)),
  notify_handover: async (p) =>
    (await import("@/lib/alerts/notify")).notifyHandover(
      String(p.conversationId),
      p.kind === "ticket" ? "ticket" : "live",
    ),
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
    (await import("@/lib/emails/process")).processEmail(String(p.emailId)),
  outlook_sync: async () => {
    await (await import("@/lib/channels/outlook")).syncMailbox();
  },
  refresh_web_sources: async () => {
    await queueWebRefresh();
  },
  retention: async () => {
    await (await import("@/lib/privacy/retention")).runRetention();
  },
  weekly_summary: async () => {
    await (await import("@/lib/reports/summary")).sendWeeklySummary();
  },
};

export function runJobsNow(opts: { budgetMs?: number } = {}) {
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

/** Once a minute (Vercel Cron): the Outlook sweep is queued here so it runs once however many instances call. */
export async function minuteTick(now = new Date()) {
  const minute = Math.floor(now.getTime() / 60_000);
  await enqueue("outlook_sync", {}, { dedupeKey: `outlook:${minute}`, maxAttempts: 1 });
  return runJobsNow({ budgetMs: 50_000 });
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
  const ran = await runJobsNow({ budgetMs: 240_000 });
  return { pruned, limits, ...ran, at: now.toISOString() };
}
