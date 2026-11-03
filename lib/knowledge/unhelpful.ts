import "server-only";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, messages, unhelpfulAnswers } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { inBots } from "@/lib/auth/bots";
import type { Actor } from "@/lib/authz";
import { addSource } from "./sources";
import { knowledgeBaseOf } from "./bases";
import { questionKey } from "./gaps";

/**
 * Answers people marked unhelpful. Unanswered questions are caught already
 * (gaps); a thumbs down is the only sign that an answer was wrong or weak.
 * Each goes on the Knowledge page with the question and what Billie said,
 * for the team to fix (saved as a typed answer) or dismiss.
 */

export type RatedAnswer = {
  botId: string;
  conversationId: string;
  answer: string;
  answeredAt: Date;
};

/** The visitor's question that a bot message answered. */
async function questionFor(a: RatedAnswer) {
  const [asked] = await db
    .select({ text: messages.text })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, a.conversationId),
        eq(messages.role, "visitor"),
        lt(messages.createdAt, a.answeredAt),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const question = asked?.text.trim().slice(0, 400) ?? "";
  const key = question ? questionKey(question) : "";
  return key ? { question, key } : null;
}

/**
 * A thumbs down: notes the question with the answer. The same question marked
 * again adds to its count. Fixed, then marked again on the new answer: back on
 * the list, counting afresh. A thumbs down on an answer from before the fix
 * changes nothing. Dismissed stays dismissed.
 */
export async function recordUnhelpful(a: RatedAnswer, now = new Date()): Promise<void> {
  try {
    const q = await questionFor(a);
    if (!q) return; // e.g. the welcome message
    const answer = a.answer.slice(0, 4000);
    await db
      .insert(unhelpfulAnswers)
      .values({
        botId: a.botId,
        questionKey: q.key,
        question: q.question,
        answer,
        firstAt: now,
        lastAt: now,
      })
      .onConflictDoUpdate({
        target: [unhelpfulAnswers.botId, unhelpfulAnswers.questionKey],
        set: {
          count: sql`CASE WHEN ${unhelpfulAnswers.status} = 'fixed' THEN 1 ELSE ${unhelpfulAnswers.count} + 1 END`,
          answer,
          lastAt: now,
          status: sql`CASE WHEN ${unhelpfulAnswers.status} = 'dismissed' THEN 'dismissed' ELSE 'open' END`,
        },
        setWhere: sql`NOT (${unhelpfulAnswers.status} = 'fixed' AND ${unhelpfulAnswers.fixedAt} > ${a.answeredAt.toISOString()})`,
      });
  } catch (err) {
    // The list is a nice-to-have: never fail a rating over it.
    console.error("unhelpful not recorded", err instanceof Error ? err.message : err);
  }
}

/** Thumbs down changed to thumbs up: a mis-tap, so it comes off the count. */
export async function withdrawUnhelpful(a: RatedAnswer): Promise<void> {
  try {
    const q = await questionFor(a);
    if (!q) return;
    await db
      .update(unhelpfulAnswers)
      .set({ count: sql`greatest(${unhelpfulAnswers.count} - 1, 0)` })
      .where(
        and(
          eq(unhelpfulAnswers.botId, a.botId),
          eq(unhelpfulAnswers.questionKey, q.key),
          eq(unhelpfulAnswers.status, "open"),
        ),
      );
  } catch (err) {
    console.error("unhelpful not withdrawn", err instanceof Error ? err.message : err);
  }
}

export type UnhelpfulRow = {
  id: string;
  botId: string;
  botName: string;
  question: string;
  answer: string;
  count: number;
  lastAt: string;
};

/** Open ones for the actor's bots (null: every bot), most marked first. */
export async function openUnhelpful(ids: string[] | null): Promise<UnhelpfulRow[]> {
  const rows = await db
    .select({
      id: unhelpfulAnswers.id,
      botId: unhelpfulAnswers.botId,
      botName: bots.name,
      question: unhelpfulAnswers.question,
      answer: unhelpfulAnswers.answer,
      count: unhelpfulAnswers.count,
      lastAt: unhelpfulAnswers.lastAt,
    })
    .from(unhelpfulAnswers)
    .innerJoin(bots, eq(bots.id, unhelpfulAnswers.botId))
    .where(
      and(
        eq(unhelpfulAnswers.status, "open"),
        gt(unhelpfulAnswers.count, 0),
        isNull(bots.deletedAt),
        inBots(ids, unhelpfulAnswers.botId),
      ),
    )
    .orderBy(desc(unhelpfulAnswers.count), desc(unhelpfulAnswers.lastAt))
    .limit(300);
  return rows.map((r) => ({ ...r, lastAt: r.lastAt.toISOString() }));
}

/** The team's better answer, saved as a typed answer in the bot's knowledge. */
export async function fixUnhelpful(
  actor: Actor,
  id: string,
  answer: string,
  now = new Date(),
): Promise<void> {
  const row = await db.query.unhelpfulAnswers.findFirst({ where: eq(unhelpfulAnswers.id, id) });
  if (!row || row.status !== "open") throw new UserError("That answer is no longer on the list.");
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, row.botId), isNull(bots.deletedAt)),
  });
  if (!bot) throw new UserError("That bot no longer exists.");
  const kb = await knowledgeBaseOf(bot.id);
  const sourceId = await addSource(actor, kb.id, { kind: "qa", question: row.question, answer });
  await db
    .update(unhelpfulAnswers)
    .set({ status: "fixed", fixedSourceId: sourceId, fixedAt: now })
    .where(eq(unhelpfulAnswers.id, id));
}

export async function dismissUnhelpful(actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(unhelpfulAnswers)
      .set({ status: "dismissed" })
      .where(eq(unhelpfulAnswers.id, id))
      .returning({ id: unhelpfulAnswers.id, botId: unhelpfulAnswers.botId });
    if (!row) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: row.botId,
      action: "status_change",
      summary: "Dismissed an answer marked unhelpful",
    });
  });
}
