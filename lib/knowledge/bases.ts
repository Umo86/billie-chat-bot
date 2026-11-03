import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, query, type DbOrTx } from "@/lib/db/client";
import { botKnowledgeBases, bots, gaps, knowledgeBases } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";
import { addSource } from "./sources";

/**
 * Every bot has one knowledge base of its own, made with the bot and named
 * after it. Bots never share: what one bot knows can't change another's
 * answers. The old link table is kept in step so a rollback still answers.
 */
export async function createBotKnowledgeBase(
  tx: DbOrTx,
  bot: { id: string; name: string },
  createdBy: string | null,
): Promise<string> {
  const [kb] = await tx
    .insert(knowledgeBases)
    .values({ botId: bot.id, name: bot.name.slice(0, 80), createdBy })
    .returning({ id: knowledgeBases.id });
  await tx
    .insert(botKnowledgeBases)
    .values({ botId: bot.id, knowledgeBaseId: kb.id })
    .onConflictDoNothing();
  return kb.id;
}

/**
 * Makes the knowledge base of any bot that has none yet (a bot made by the
 * release before this one, while both were running). Cheap when there's
 * nothing to do.
 */
export async function ensureBotKnowledgeBases(): Promise<void> {
  const made = await query<{ id: string; bot_id: string }>(
    db,
    sql`INSERT INTO knowledge_bases (bot_id, name)
        SELECT b.id, left(b.name, 80) FROM bots b
         WHERE NOT EXISTS (SELECT 1 FROM knowledge_bases k WHERE k.bot_id = b.id)
        ON CONFLICT (bot_id) DO NOTHING
        RETURNING id, bot_id`,
  );
  for (const r of made)
    await db
      .insert(botKnowledgeBases)
      .values({ botId: r.bot_id, knowledgeBaseId: r.id })
      .onConflictDoNothing();
}

/** A bot's own knowledge base (made now if it has none). */
export async function knowledgeBaseOf(botId: string): Promise<{ id: string; name: string }> {
  const find = () =>
    db.query.knowledgeBases.findFirst({
      where: eq(knowledgeBases.botId, botId),
      columns: { id: true, name: true },
    });
  const kb = await find();
  if (kb) return kb;
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, botId) });
  if (!bot) throw new UserError("That bot no longer exists.");
  await ensureBotKnowledgeBases();
  const made = await find();
  if (!made) throw new UserError("That bot no longer exists.");
  return made;
}

/** Keeps a bot's knowledge base named after it. */
export async function renameBotKnowledgeBase(tx: DbOrTx, botId: string, name: string) {
  await tx
    .update(knowledgeBases)
    .set({ name: name.slice(0, 80) })
    .where(eq(knowledgeBases.botId, botId));
}

/**
 * Only an old shared knowledge base that no bot answers from can be deleted
 * here; a bot's own goes with the bot.
 */
export async function setKnowledgeBaseDeleted(actor: Actor, id: string, deleted: boolean) {
  await db.transaction(async (tx) => {
    const kb = await tx.query.knowledgeBases.findFirst({ where: eq(knowledgeBases.id, id) });
    if (!kb) return;
    if (kb.botId)
      throw new UserError(
        "This is a bot's own knowledge. It's deleted with the bot, from the bot's Go live step.",
      );
    await tx
      .update(knowledgeBases)
      .set({ deletedAt: deleted ? new Date() : null })
      .where(eq(knowledgeBases.id, id));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "knowledge_base",
      entityId: id,
      action: deleted ? "delete" : "restore",
      summary: deleted
        ? `Deleted knowledge base "${kb.name}" (in the bin for 30 days)`
        : `Restored knowledge base "${kb.name}"`,
    });
  });
}

/** One click from the gaps list: the answer becomes a typed answer in that bot's knowledge. */
export async function answerGap(actor: Actor, gapId: string, answer: string): Promise<void> {
  const gap = await db.query.gaps.findFirst({ where: eq(gaps.id, gapId) });
  if (!gap) throw new UserError("That question is no longer on the list.");
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, gap.botId), isNull(bots.deletedAt)),
  });
  if (!bot) throw new UserError("That bot no longer exists.");
  const kb = await knowledgeBaseOf(bot.id);
  const sourceId = await addSource(actor, kb.id, { kind: "qa", question: gap.question, answer });
  await db
    .update(gaps)
    .set({ status: "answered", answeredSourceId: sourceId })
    .where(eq(gaps.id, gapId));
}

export async function dismissGap(actor: Actor, gapId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [g] = await tx
      .update(gaps)
      .set({ status: "dismissed" })
      .where(eq(gaps.id, gapId))
      .returning({ id: gaps.id });
    if (!g) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "gap",
      entityId: gapId,
      action: "status_change",
      summary: "Dismissed an unanswered question",
    });
  });
}
