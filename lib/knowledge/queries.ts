import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { passages } from "@/lib/db/schema";

export type KbSummary = {
  id: string;
  name: string;
  description: string;
  sources: number;
  passages: number;
  usedBy: { id: string; name: string }[];
};

export async function knowledgeBaseList(): Promise<KbSummary[]> {
  const rows = await query<{
    id: string;
    name: string;
    description: string;
    sources: number;
    passages: number;
    used_by: { id: string; name: string }[] | null;
  }>(
    db,
    sql`SELECT kb.id, kb.name, kb.description,
          (SELECT count(*)::int FROM sources s WHERE s.knowledge_base_id = kb.id AND s.deleted_at IS NULL) AS sources,
          (SELECT coalesce(sum(s.passage_count), 0)::int FROM sources s WHERE s.knowledge_base_id = kb.id AND s.deleted_at IS NULL AND s.status = 'ready') AS passages,
          (SELECT json_agg(json_build_object('id', b.id, 'name', b.name) ORDER BY b.name)
             FROM bot_knowledge_bases bk JOIN bots b ON b.id = bk.bot_id
            WHERE bk.knowledge_base_id = kb.id AND b.deleted_at IS NULL) AS used_by
        FROM knowledge_bases kb WHERE kb.deleted_at IS NULL ORDER BY kb.name`,
  );
  return rows.map((r) => ({ ...r, usedBy: r.used_by ?? [] }));
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
  }>(
    db,
    sql`SELECT s.id, s.title, s.kind, s.status, s.error, s.file_name, s.url, s.refresh_weekly, s.passage_count,
               u.full_name AS added_by, s.created_at, s.last_read_at
        FROM sources s LEFT JOIN users u ON u.id = s.added_by
        WHERE s.knowledge_base_id = ${kbId} AND s.deleted_at IS NULL
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
  }));
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
  kbIds: string[];
};

export async function openGaps(): Promise<GapRow[]> {
  const rows = await query<{
    id: string;
    bot_id: string;
    bot_name: string;
    question: string;
    ask_count: number;
    last_asked_at: Date;
    kb_ids: string[] | null;
  }>(
    db,
    sql`SELECT g.id, g.bot_id, b.name AS bot_name, g.question, g.ask_count, g.last_asked_at,
          (SELECT array_agg(bk.knowledge_base_id) FROM bot_knowledge_bases bk WHERE bk.bot_id = g.bot_id) AS kb_ids
        FROM gaps g JOIN bots b ON b.id = g.bot_id
        WHERE g.status = 'open' AND b.deleted_at IS NULL
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
    kbIds: r.kb_ids ?? [],
  }));
}
