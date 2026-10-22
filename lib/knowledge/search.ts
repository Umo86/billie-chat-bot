import "server-only";
import { sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import type { PromptPassage } from "@/lib/ai/prompts";
import { embedQuery } from "./embed";
import { fuseRankings, searchTerms } from "./rank";

/**
 * Finding the passages an answer is written from. A bot with a small
 * knowledge base sends all of it (identical every time, so prompt caching
 * makes it cheap). Otherwise keyword search (Postgres full-text) and meaning
 * search (pgvector) each pick candidates, Reciprocal Rank Fusion merges
 * them, and the best fill a fixed character budget.
 */
export const SEND_ALL_CHARS = 24_000;
export const BUDGET_CHARS = 14_000;
export const MAX_PASSAGES = 10;
const CANDIDATES = 30;

type Row = {
  id: string;
  source_id: string;
  source_title: string;
  kind: PromptPassage["kind"];
  label: string;
  text: string;
};

/** Ready, not-deleted sources in live (not-deleted) knowledge bases. */
function liveFilter(kbIds: string[]) {
  return sql`p.knowledge_base_id IN ${kbIds}
    AND s.status = 'ready' AND s.deleted_at IS NULL AND kb.deleted_at IS NULL`;
}

function toPrompt(r: Row): PromptPassage {
  return { sourceId: r.source_id, sourceTitle: r.source_title, label: r.label, text: r.text, kind: r.kind };
}

/** to_tsquery input: "a | b | c" from cleaned words, or null when nothing searchable is left. */
export function orQuery(question: string): string | null {
  const terms = searchTerms(question).map((t) => t.replace(/[^a-z0-9]/g, "")).filter(Boolean);
  return terms.length ? terms.join(" | ") : null;
}

export async function knowledgeSize(kbIds: string[]): Promise<number> {
  if (!kbIds.length) return 0;
  const rows = await query<{ chars: string | null }>(db, sql`
    SELECT sum(length(p.text))::bigint AS chars
    FROM passages p
    JOIN sources s ON s.id = p.source_id
    JOIN knowledge_bases kb ON kb.id = p.knowledge_base_id
    WHERE ${liveFilter(kbIds)}`);
  return Number(rows[0]?.chars ?? 0);
}

export async function retrieve(kbIds: string[], question: string): Promise<PromptPassage[]> {
  if (!kbIds.length) return [];
  const size = await knowledgeSize(kbIds);
  if (size === 0) return [];

  if (size <= SEND_ALL_CHARS) {
    const rows = await query<Row>(db, sql`
      SELECT p.id, p.source_id, s.title AS source_title, s.kind, p.label, p.text
      FROM passages p
      JOIN sources s ON s.id = p.source_id
      JOIN knowledge_bases kb ON kb.id = p.knowledge_base_id
      WHERE ${liveFilter(kbIds)}
      ORDER BY s.kind = 'qa' DESC, s.created_at, p.ordinal`);
    return rows.map(toPrompt);
  }

  const tsq = orQuery(question);
  const [keyword, vector] = await Promise.all([
    tsq
      ? query<Row & { rank: number }>(db, sql`
          SELECT p.id, p.source_id, s.title AS source_title, s.kind, p.label, p.text,
                 ts_rank_cd(p.search, to_tsquery('english', ${tsq})) AS rank
          FROM passages p
          JOIN sources s ON s.id = p.source_id
          JOIN knowledge_bases kb ON kb.id = p.knowledge_base_id
          WHERE ${liveFilter(kbIds)} AND p.search @@ to_tsquery('english', ${tsq})
          ORDER BY rank DESC
          LIMIT ${CANDIDATES}`)
      : Promise.resolve([] as (Row & { rank: number })[]),
    (async () => {
      const q = await embedQuery(question);
      if (!q) return [] as Row[];
      const vec = `[${q.join(",")}]`;
      return query<Row>(db, sql`
        SELECT p.id, p.source_id, s.title AS source_title, s.kind, p.label, p.text
        FROM passages p
        JOIN sources s ON s.id = p.source_id
        JOIN knowledge_bases kb ON kb.id = p.knowledge_base_id
        WHERE ${liveFilter(kbIds)} AND p.embedding IS NOT NULL
        ORDER BY p.embedding <=> ${vec}::vector
        LIMIT ${CANDIDATES}`);
    })(),
  ]);

  const byId = new Map<string, Row>();
  for (const r of [...keyword, ...vector]) byId.set(r.id, r);
  const boost = (r: Row) => (r.kind === "qa" ? 0.3 : 0);
  const fused = fuseRankings([
    keyword.map((r) => ({ id: r.id, boost: boost(r) })),
    vector.map((r) => ({ id: r.id, boost: boost(r) })),
  ]);

  const out: PromptPassage[] = [];
  let used = 0;
  for (const { id } of fused) {
    const r = byId.get(id);
    if (!r) continue;
    if (out.length >= MAX_PASSAGES || used + r.text.length > BUDGET_CHARS) break;
    out.push(toPrompt(r));
    used += r.text.length;
  }
  return out;
}
