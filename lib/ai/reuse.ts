import "server-only";
import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { aiUsage, answerCache } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";
import { londonDate } from "@/lib/time";
import type { AnswerResult } from "./answer";
import { linksGrounded, reusableQuestion, tidyQuestion } from "./reuse-rules";

/**
 * Giving an earlier answer again: at shows, many people ask the same first
 * question ("When does build-up start?"). The same question, to the same bot,
 * with the same knowledge and settings, on the same UK day and channel, gets
 * the answer Claude gave before, costing no tokens. Only confident answers
 * that didn't need a person, never a signed-in exhibitor's, never in a test,
 * and only for a chat's first question (follow-ups depend on what came
 * before). Marking one unhelpful forgets it.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Changes whenever the bot, its knowledge or its passages change. */
async function knowledgeStamp(botId: string, kbIds: string[]): Promise<string> {
  const kb = kbIds.length ? sql`IN ${kbIds}` : sql`IS NULL`;
  const [row] = await query<{ stamp: string }>(
    db,
    sql`SELECT concat_ws('|',
          (SELECT updated_at::text FROM bots WHERE id = ${botId}),
          (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM sources WHERE knowledge_base_id ${kb}),
          (SELECT count(*)::text || ':' || coalesce(max(created_at)::text, '') FROM passages WHERE knowledge_base_id ${kb})
        ) AS stamp`,
  );
  return row?.stamp ?? "";
}

export type ReuseKey = { key: string; botId: string; day: string };

/** The key for this question, or null if it can't be reused (or reuse is off). */
export async function reuseKey(
  bot: { id: string; knowledgeBaseIds: string[] },
  question: string,
  channel: "web" | "whatsapp",
  now = new Date(),
): Promise<ReuseKey | null> {
  if (!reusableQuestion(question)) return null;
  if (!(await getSettings()).reuseAnswers) return null;
  const day = londonDate(now);
  const stamp = await knowledgeStamp(bot.id, bot.knowledgeBaseIds);
  return {
    key: sha(`${bot.id}|${stamp}|${day}|${channel}|${tidyQuestion(question)}`),
    botId: bot.id,
    day,
  };
}

type Stored = Omit<AnswerResult, "meta">;

/** An earlier answer to give again, counted as a reuse with what it saved. */
export async function takeReused(k: ReuseKey): Promise<Stored | null> {
  const [hit] = await db
    .update(answerCache)
    .set({ hits: sql`${answerCache.hits} + 1` })
    .where(eq(answerCache.key, k.key))
    .returning({ answer: answerCache.answer, cost: answerCache.costMicros });
  if (!hit) return null;
  await db
    .insert(aiUsage)
    .values({
      day: k.day,
      scope: `bot:${k.botId}`,
      model: "reused",
      requests: 1,
      savedMicros: hit.cost,
    })
    .onConflictDoUpdate({
      target: [aiUsage.day, aiUsage.scope, aiUsage.model],
      set: {
        requests: sql`${aiUsage.requests} + 1`,
        savedMicros: sql`${aiUsage.savedMicros} + ${hit.cost}`,
      },
    });
  return hit.answer as unknown as Stored;
}

/** Keeps an answer to give again, if it's the kind that can be. */
export async function keepForReuse(
  k: ReuseKey,
  a: AnswerResult,
  costMicros: number,
  passages: string[],
) {
  if (a.handover !== "none" || !a.confident || !a.answer.trim()) return;
  if (!linksGrounded(a.answer, passages)) return;
  const stored: Stored = {
    answer: a.answer,
    sources: a.sources,
    handover: a.handover,
    confident: a.confident,
    topic: a.topic,
    request: a.request,
    links: a.links,
    flag: a.flag,
  };
  await db
    .insert(answerCache)
    .values({
      key: k.key,
      botId: k.botId,
      day: k.day,
      answer: stored as unknown as Record<string, unknown>,
      answerHash: sha(a.answer),
      costMicros,
    })
    .onConflictDoNothing();
}

/** Someone found this answer unhelpful: nobody else gets it again. */
export async function forgetReused(botId: string, answerText: string): Promise<void> {
  await db
    .delete(answerCache)
    .where(and(eq(answerCache.botId, botId), eq(answerCache.answerHash, sha(answerText))));
}

/** Answers kept for reuse are only for their day: older ones go (daily job). */
export async function pruneReused(now = new Date()): Promise<number> {
  const d = new Date(`${londonDate(now)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const gone = await db
    .delete(answerCache)
    .where(lt(answerCache.day, d.toISOString().slice(0, 10)))
    .returning({ key: answerCache.key });
  return gone.length;
}
