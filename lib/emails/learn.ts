import "server-only";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { bots, emailThreads } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";
import { inBots } from "@/lib/auth/bots";
import { enqueue } from "@/lib/jobs/queue";
import { AiError, structured } from "@/lib/ai/provider";
import { modelsFor } from "@/lib/ai/chosen";
import { learnFromSentSystem, learnFromSentUser } from "@/lib/ai/prompts";
import { learnFromSentJsonSchema, learnFromSentSchema } from "@/lib/ai/schemas";
import { aiLimit, LIMIT_LINE, recordUsage } from "@/lib/ai/usage";
import { knowledgeBaseOf } from "@/lib/knowledge/bases";
import { addSource } from "@/lib/knowledge/sources";
import type { SentLearning } from "@/lib/types";
import { replyPart, sameReply } from "./learn-rules";

/**
 * Learning from what the team sends. Billie looks for its Outlook drafts
 * every ten minutes: one sent unchanged counts towards "sent unchanged"
 * (how far to trust the drafts); one the team changed is compared with
 * Billie's, and a corrected fact is offered on the Knowledge page as a
 * typed answer, for a person to save or dismiss. Nothing is saved by itself.
 */

const LOOK_FOR_DAYS = 14;
const LOOK_EVERY_MS = 10 * 60_000;

/** The "outlook_sent_check" job. Returns how many drafts it found sent or gone. */
export async function checkSentDrafts(now = new Date()): Promise<number> {
  const { sentState } = await import("@/lib/channels/outlook");
  const due = await db
    .select({
      id: emailThreads.id,
      mailbox: emailThreads.mailbox,
      draftId: emailThreads.outlookDraftId,
      draft: emailThreads.draft,
      status: emailThreads.status,
    })
    .from(emailThreads)
    .where(
      and(
        eq(emailThreads.source, "outlook"),
        isNotNull(emailThreads.outlookDraftId),
        isNull(emailThreads.sentOutcome),
        inArray(emailThreads.status, ["draft_ready", "needs_you"]),
        gt(emailThreads.createdAt, new Date(now.getTime() - LOOK_FOR_DAYS * 86_400_000)),
        or(
          isNull(emailThreads.sentCheckedAt),
          lt(emailThreads.sentCheckedAt, new Date(now.getTime() - LOOK_EVERY_MS)),
        ),
      ),
    )
    .orderBy(sql`${emailThreads.sentCheckedAt} NULLS FIRST`, asc(emailThreads.createdAt))
    .limit(40);
  let found = 0;
  for (const e of due) {
    if (!e.mailbox || !e.draftId) continue;
    const s = await sentState(e.mailbox, e.draftId);
    if (s.state === "draft") {
      await db.update(emailThreads).set({ sentCheckedAt: now }).where(eq(emailThreads.id, e.id));
      continue;
    }
    found++;
    if (s.state === "gone") {
      await db
        .update(emailThreads)
        .set({ sentOutcome: "discarded", sentCheckedAt: now })
        .where(eq(emailThreads.id, e.id));
      continue;
    }
    const sent = replyPart(s.text);
    const unchanged = sameReply(e.draft, sent);
    await db.transaction(async (tx) => {
      await tx
        .update(emailThreads)
        .set({
          status: "sent",
          sentOutcome: unchanged ? "unchanged" : "edited",
          sentText: sent.slice(0, 20_000),
          sentAt: s.sentAt,
          sentCheckedAt: now,
          handledAt: s.sentAt,
        })
        .where(eq(emailThreads.id, e.id));
      await writeAudit(tx, {
        actorType: "system",
        entityType: "email",
        entityId: e.id,
        action: "status_change",
        summary: unchanged
          ? "Billie's draft was sent from Outlook unchanged"
          : "Billie's draft was sent from Outlook with changes",
      });
      if (!unchanged)
        await enqueue(
          "learn_from_sent",
          { emailId: e.id },
          { tx, dedupeKey: `learn:${e.id}`, once: true, maxAttempts: 3 },
        );
    });
  }
  return found;
}

/** The "learn_from_sent" job: a corrected fact to offer as a typed answer, if there is one. */
export async function learnFromSent(emailId: string): Promise<void> {
  const e = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, emailId) });
  if (!e || e.sentOutcome !== "edited" || !e.sentText || !e.botId || e.learning) return;
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, e.botId) });
  if (!bot || bot.deletedAt) return;
  const limit = await aiLimit("staff");
  if (limit) throw new Error(`${LIMIT_LINE[limit]}.`);
  try {
    const result = await structured({
      purpose: "learn_from_sent",
      ...(await modelsFor("thorough")),
      system: learnFromSentSystem(bot.showName),
      user: learnFromSentUser({
        subject: e.subject,
        email: e.body,
        draft: e.draft,
        sent: e.sentText,
      }),
      schema: learnFromSentJsonSchema,
      maxTokens: 600,
      fake: { purpose: "learn_from_sent", subject: e.subject, draft: e.draft, sent: e.sentText },
    });
    await recordUsage("learning", result.usage, result.model);
    const d = learnFromSentSchema.parse(result.json);
    if (!d.learned || !d.question.trim() || !d.answer.trim()) return;
    const learning: SentLearning = {
      status: "offered",
      question: d.question.trim().slice(0, 300),
      answer: d.answer.trim().slice(0, 4000),
      why: d.why.trim().slice(0, 200),
      at: new Date().toISOString(),
    };
    await db.update(emailThreads).set({ learning }).where(eq(emailThreads.id, emailId));
  } catch (err) {
    if (err instanceof AiError && err.code === "not_configured") return;
    throw err;
  }
}

export type LearningOffer = {
  emailId: string;
  botId: string;
  botName: string;
  subject: string;
  sentAt: string | null;
  draft: string;
  sent: string;
  learning: SentLearning;
};

/** Corrections waiting on the Knowledge page, for the actor's bots (null: every bot). */
export async function learningOffers(ids: string[] | null): Promise<LearningOffer[]> {
  const rows = await query<{
    id: string;
    bot_id: string;
    bot_name: string;
    subject: string;
    sent_at: Date | null;
    draft: string;
    sent_text: string | null;
    learning: SentLearning;
  }>(
    db,
    sql`SELECT e.id, e.bot_id, b.name AS bot_name, e.subject, e.sent_at, e.draft, e.sent_text, e.learning
          FROM email_threads e JOIN bots b ON b.id = e.bot_id
         WHERE e.learning->>'status' = 'offered' AND b.deleted_at IS NULL
           AND ${inBots(ids, sql`e.bot_id`)}
         ORDER BY e.sent_at DESC NULLS LAST
         LIMIT 100`,
  );
  return rows.map((r) => ({
    emailId: r.id,
    botId: r.bot_id,
    botName: r.bot_name,
    subject: r.subject,
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    draft: r.draft,
    sent: r.sent_text ?? "",
    learning: r.learning,
  }));
}

/** Saves the correction (as edited by the person) as a typed answer in the email's bot. */
export async function saveLearning(
  actor: Actor,
  emailId: string,
  qa: { question: string; answer: string },
): Promise<void> {
  const e = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, emailId) });
  if (!e?.learning || e.learning.status !== "offered" || !e.botId)
    throw new UserError("That correction is no longer waiting.");
  const kb = await knowledgeBaseOf(e.botId);
  await addSource(actor, kb.id, { kind: "qa", question: qa.question, answer: qa.answer });
  await db
    .update(emailThreads)
    .set({ learning: { ...e.learning, status: "saved", question: qa.question, answer: qa.answer } })
    .where(eq(emailThreads.id, emailId));
}

export async function dismissLearning(actor: Actor, emailId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const e = await tx.query.emailThreads.findFirst({ where: eq(emailThreads.id, emailId) });
    if (!e?.learning || e.learning.status !== "offered") return;
    await tx
      .update(emailThreads)
      .set({ learning: { ...e.learning, status: "dismissed" } })
      .where(eq(emailThreads.id, emailId));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "email",
      entityId: emailId,
      action: "update",
      summary: "Dismissed a correction from a sent email",
    });
  });
}

/** Drafts sent from Outlook since a date: unchanged and changed (for Reports). */
export async function sentCounts(
  since: Date,
  ids: string[] | null,
): Promise<{ unchanged: number; edited: number }> {
  const [row] = await query<{ unchanged: number; edited: number }>(
    db,
    sql`SELECT count(*) FILTER (WHERE sent_outcome = 'unchanged')::int AS unchanged,
               count(*) FILTER (WHERE sent_outcome = 'edited')::int AS edited
          FROM email_threads
         WHERE sent_at >= ${since.toISOString()} AND ${inBots(ids, sql`bot_id`)}`,
  );
  return row ?? { unchanged: 0, edited: 0 };
}

/** Is there anything for the sent check to look at? (So the job isn't queued for nothing.) */
export async function hasDraftsToCheck(now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ id: emailThreads.id })
    .from(emailThreads)
    .where(
      and(
        eq(emailThreads.source, "outlook"),
        isNotNull(emailThreads.outlookDraftId),
        isNull(emailThreads.sentOutcome),
        inArray(emailThreads.status, ["draft_ready", "needs_you"]),
        gt(emailThreads.createdAt, new Date(now.getTime() - LOOK_FOR_DAYS * 86_400_000)),
      ),
    )
    .orderBy(desc(emailThreads.createdAt))
    .limit(1);
  return Boolean(row);
}
