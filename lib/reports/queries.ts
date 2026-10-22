import "server-only";
import { sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";

/**
 * Reports: what people ask, how much Billie answers alone, when it's busy.
 * Staff test chats (channel "try") are left out so they don't skew numbers.
 * Hours are UK time.
 */
export type Kpis = {
  chats: number;
  answeredAlonePct: number | null;
  handedOver: number;
  emailsDrafted: number;
  openGaps: number;
  helpfulPct: number | null;
};

export async function kpis(since: Date): Promise<Kpis> {
  const [row] = await query<{
    chats: number;
    handed: number;
    emails: number;
    gaps: number;
    up: number;
    down: number;
  }>(
    db,
    sql`SELECT
      (SELECT count(*)::int FROM conversations WHERE channel <> 'try' AND created_at >= ${since.toISOString()}) AS chats,
      (SELECT count(*)::int FROM conversations WHERE channel <> 'try' AND created_at >= ${since.toISOString()} AND handover_at IS NOT NULL) AS handed,
      (SELECT count(*)::int FROM email_threads WHERE created_at >= ${since.toISOString()} AND status IN ('draft_ready', 'sent')) AS emails,
      (SELECT count(*)::int FROM gaps WHERE status = 'open') AS gaps,
      (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.channel <> 'try' AND m.rating = 1 AND m.created_at >= ${since.toISOString()}) AS up,
      (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.channel <> 'try' AND m.rating = -1 AND m.created_at >= ${since.toISOString()}) AS down`,
  );
  return {
    chats: row.chats,
    answeredAlonePct: row.chats ? Math.round(((row.chats - row.handed) / row.chats) * 100) : null,
    handedOver: row.handed,
    emailsDrafted: row.emails,
    openGaps: row.gaps,
    helpfulPct: row.up + row.down ? Math.round((row.up / (row.up + row.down)) * 100) : null,
  };
}

export async function topQuestions(since: Date, limit = 10) {
  return query<{ question: string; times: number }>(
    db,
    sql`SELECT min(first_question) AS question, count(*)::int AS times
        FROM conversations
        WHERE channel <> 'try' AND first_question <> '' AND created_at >= ${since.toISOString()}
        GROUP BY lower(regexp_replace(first_question, '[^a-zA-Z0-9 ]+', '', 'g'))
        ORDER BY times DESC, question
        LIMIT ${limit}`,
  );
}

/** Chats started per hour of the day (0–23, UK time). */
export async function busiestHours(since: Date): Promise<number[]> {
  const rows = await query<{ hour: number; n: number }>(
    db,
    sql`SELECT extract(hour FROM created_at AT TIME ZONE 'Europe/London')::int AS hour, count(*)::int AS n
        FROM conversations WHERE channel <> 'try' AND created_at >= ${since.toISOString()}
        GROUP BY 1`,
  );
  const out = new Array<number>(24).fill(0);
  for (const r of rows) out[r.hour] = r.n;
  return out;
}

export async function perBot(since: Date) {
  return query<{
    id: string;
    name: string;
    color: string;
    status: string;
    chats: number;
    handed: number;
    open_gaps: number;
    last_test: { passed: number; total: number } | null;
  }>(
    db,
    sql`SELECT b.id, b.name, b.color, b.status,
          (SELECT count(*)::int FROM conversations c WHERE c.bot_id = b.id AND c.channel <> 'try' AND c.created_at >= ${since.toISOString()}) AS chats,
          (SELECT count(*)::int FROM conversations c WHERE c.bot_id = b.id AND c.channel <> 'try' AND c.created_at >= ${since.toISOString()} AND c.handover_at IS NOT NULL) AS handed,
          (SELECT count(*)::int FROM gaps g WHERE g.bot_id = b.id AND g.status = 'open') AS open_gaps,
          b.last_test_run AS last_test
        FROM bots b WHERE b.deleted_at IS NULL ORDER BY b.name`,
  );
}

/** Claude use over the period (requests and tokens), for the cost line on Reports. */
export async function usageSince(since: Date) {
  const [row] = await query<{ requests: number; input: number; output: number; cached: number }>(
    db,
    sql`SELECT coalesce(sum(requests), 0)::int AS requests, coalesce(sum(input_tokens), 0)::int AS input,
               coalesce(sum(output_tokens), 0)::int AS output, coalesce(sum(cached_tokens), 0)::int AS cached
        FROM usage_daily WHERE day >= ${since.toISOString().slice(0, 10)}`,
  );
  return row;
}
