import "server-only";
import { sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { inBots } from "@/lib/auth/bots";
import type { TestRun } from "@/lib/types";

export type BotCardData = {
  id: string;
  name: string;
  slug: string;
  audience: "visitors" | "exhibitors";
  showName: string;
  color: string;
  avatarUrl: string | null;
  status: "draft" | "live";
  chats7d: number;
  handed7d: number;
  passages: number;
  lastTestRun: TestRun | null;
};

/** The actor's bots (ids from myBotIds; null is every bot) with their week's numbers, for Home. */
export async function botCards(ids: string[] | null): Promise<BotCardData[]> {
  const rows = await query<{
    id: string;
    name: string;
    slug: string;
    audience: "visitors" | "exhibitors";
    show_name: string;
    color: string;
    avatar_url: string | null;
    status: "draft" | "live";
    chats: number;
    handed: number;
    passages: number;
    last_test_run: TestRun | null;
  }>(
    db,
    sql`SELECT b.id, b.name, b.slug, b.audience, b.show_name, b.color, b.avatar_url, b.status, b.last_test_run,
          (SELECT count(*)::int FROM conversations c WHERE c.bot_id = b.id AND c.channel <> 'try' AND c.created_at > now() - interval '7 days') AS chats,
          (SELECT count(*)::int FROM conversations c WHERE c.bot_id = b.id AND c.channel <> 'try' AND c.handover_at > now() - interval '7 days') AS handed,
          (SELECT count(*)::int FROM passages p
             JOIN sources s ON s.id = p.source_id
             JOIN knowledge_bases kb ON kb.id = p.knowledge_base_id
            WHERE kb.bot_id = b.id AND s.deleted_at IS NULL AND s.status = 'ready' AND kb.deleted_at IS NULL) AS passages
        FROM bots b WHERE b.deleted_at IS NULL AND ${inBots(ids, sql`b.id`)}
        ORDER BY b.created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    audience: r.audience,
    showName: r.show_name,
    color: r.color,
    avatarUrl: r.avatar_url,
    status: r.status,
    chats7d: r.chats,
    handed7d: r.handed,
    passages: r.passages,
    lastTestRun: r.last_test_run,
  }));
}

/** What's waiting on the actor's bots (null is every bot). */
export async function homeCounters(ids: string[] | null) {
  const [row] = await query<{ waiting: number; emails: number; gaps: number }>(
    db,
    sql`SELECT
      (SELECT count(*)::int FROM conversations WHERE status IN ('waiting', 'ticket') AND ${inBots(ids, sql`bot_id`)}) AS waiting,
      (SELECT count(*)::int FROM email_threads WHERE status IN ('draft_ready', 'needs_you', 'failed') AND ${inBots(ids, sql`bot_id`)}) AS emails,
      (SELECT count(*)::int FROM gaps WHERE status = 'open' AND ${inBots(ids, sql`bot_id`)}) AS gaps`,
  );
  return row;
}
