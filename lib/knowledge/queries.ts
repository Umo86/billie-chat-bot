import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { inBots } from "@/lib/auth/bots";
import { passages, sources } from "@/lib/db/schema";
import type { FreshStatus } from "./learning";

export type KbBot = {
  id: string;
  name: string;
  color: string;
  avatarUrl: string | null;
  status: "draft" | "live";
};

export type KbSummary = {
  id: string;
  /** The bot's name (an old shared base keeps its own). */
  name: string;
  sources: number;
  passages: number;
  /** Whose knowledge it is; null for an old shared base no bot answers from. */
  bot: KbBot | null;
};

/**
 * The knowledge of the actor's bots (null: every bot), by bot name, then any
 * old shared bases no bot uses (only for people who see every bot).
 */
export async function knowledgeBaseList(ids: string[] | null): Promise<KbSummary[]> {
  const rows = await query<{
    id: string;
    name: string;
    sources: number;
    passages: number;
    bot_id: string | null;
    color: string | null;
    avatar_url: string | null;
    status: "draft" | "live" | null;
  }>(
    db,
    sql`SELECT kb.id, coalesce(b.name, kb.name) AS name, b.id AS bot_id, b.color, b.avatar_url, b.status,
          (SELECT count(*)::int FROM sources s WHERE s.knowledge_base_id = kb.id AND s.deleted_at IS NULL) AS sources,
          (SELECT coalesce(sum(s.passage_count), 0)::int FROM sources s WHERE s.knowledge_base_id = kb.id AND s.deleted_at IS NULL AND s.status = 'ready') AS passages
        FROM knowledge_bases kb LEFT JOIN bots b ON b.id = kb.bot_id
        WHERE kb.deleted_at IS NULL AND (kb.bot_id IS NULL OR b.deleted_at IS NULL)
          AND ${inBots(ids, sql`kb.bot_id`)}
        ORDER BY kb.bot_id IS NULL, lower(coalesce(b.name, kb.name)), kb.created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sources: r.sources,
    passages: r.passages,
    bot: r.bot_id
      ? {
          id: r.bot_id,
          name: r.name,
          color: r.color ?? "#0d6a5b",
          avatarUrl: r.avatar_url,
          status: r.status ?? "draft",
        }
      : null,
  }));
}

export type SourceRow = {
  id: string;
  title: string;
  kind: "file" | "text" | "qa" | "web";
  status: "queued" | "reading" | "ready" | "failed";
  error: string | null;
  fileName: string | null;
  url: string | null;
  refreshWeekly: boolean;
  passageCount: number;
  addedBy: string | null;
  createdAt: string;
  lastReadAt: string | null;
  /** When a read last found different words. */
  changedAt: string | null;
  /** Waiting or reading for over five minutes: offer "Read again". */
  stuck: boolean;
};

export async function sourcesFor(kbId: string): Promise<SourceRow[]> {
  const rows = await query<{
    id: string;
    title: string;
    kind: SourceRow["kind"];
    status: SourceRow["status"];
    error: string | null;
    file_name: string | null;
    url: string | null;
    refresh_weekly: boolean;
    passage_count: number;
    added_by: string | null;
    created_at: Date;
    last_read_at: Date | null;
    content_changed_at: Date | null;
    stuck: boolean;
  }>(
    db,
    sql`SELECT s.id, s.title, s.kind, s.status, s.error, s.file_name, s.url, s.refresh_weekly, s.passage_count,
               u.full_name AS added_by, s.created_at, s.last_read_at, s.content_changed_at,
               (s.status IN ('queued', 'reading') AND s.updated_at < now() - interval '5 minutes') AS stuck
        FROM sources s LEFT JOIN users u ON u.id = s.added_by
        WHERE s.knowledge_base_id = ${kbId} AND s.deleted_at IS NULL
          AND s.website_id IS NULL -- a website's pages show on its own card
        ORDER BY s.kind = 'qa', s.created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    status: r.status,
    error: r.error,
    fileName: r.file_name,
    url: r.url,
    refreshWeekly: r.refresh_weekly,
    passageCount: r.passage_count,
    addedBy: r.added_by,
    createdAt: new Date(r.created_at).toISOString(),
    lastReadAt: r.last_read_at ? new Date(r.last_read_at).toISOString() : null,
    changedAt: r.content_changed_at ? new Date(r.content_changed_at).toISOString() : null,
    stuck: Boolean(r.stuck),
  }));
}

/** How the reading is going, for the panel shown after an upload (deleted sources left out). */
export async function sourceStatuses(ids: string[]): Promise<FreshStatus[]> {
  if (!ids.length) return [];
  return db
    .select({
      id: sources.id,
      status: sources.status,
      passageCount: sources.passageCount,
      error: sources.error,
    })
    .from(sources)
    .where(and(inArray(sources.id, ids), isNull(sources.deletedAt)));
}

export async function passagesOf(sourceId: string) {
  return db
    .select({ ordinal: passages.ordinal, label: passages.label, text: passages.text })
    .from(passages)
    .where(eq(passages.sourceId, sourceId))
    .orderBy(asc(passages.ordinal))
    .limit(500);
}

export type GapRow = {
  id: string;
  botId: string;
  botName: string;
  question: string;
  askCount: number;
  lastAskedAt: string;
};

/** Questions the actor's bots (null: every bot) couldn't answer. */
export async function openGaps(ids: string[] | null): Promise<GapRow[]> {
  const rows = await query<{
    id: string;
    bot_id: string;
    bot_name: string;
    question: string;
    ask_count: number;
    last_asked_at: Date;
  }>(
    db,
    sql`SELECT g.id, g.bot_id, b.name AS bot_name, g.question, g.ask_count, g.last_asked_at
        FROM gaps g JOIN bots b ON b.id = g.bot_id
        WHERE g.status = 'open' AND b.deleted_at IS NULL AND ${inBots(ids, sql`g.bot_id`)}
        ORDER BY g.ask_count DESC, g.last_asked_at DESC
        LIMIT 300`,
  );
  return rows.map((r) => ({
    id: r.id,
    botId: r.bot_id,
    botName: r.bot_name,
    question: r.question,
    askCount: r.ask_count,
    lastAskedAt: new Date(r.last_asked_at).toISOString(),
  }));
}
