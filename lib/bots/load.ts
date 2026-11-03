import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, knowledgeBases } from "@/lib/db/schema";
import type { AnswerBot } from "@/lib/ai/answer";

export type BotRow = typeof bots.$inferSelect;

/** What a bot answers from: its own knowledge base (none only for a bot made mid-release). */
export async function knowledgeBaseIdsFor(botId: string): Promise<string[]> {
  const rows = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.botId, botId), isNull(knowledgeBases.deletedAt)));
  return rows.map((r) => r.id);
}

export async function botBySlug(slug: string): Promise<BotRow | null> {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.slug, slug), isNull(bots.deletedAt)),
  });
  return bot ?? null;
}

export async function botById(id: string): Promise<BotRow | null> {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, id), isNull(bots.deletedAt)),
  });
  return bot ?? null;
}

export async function answerBotFor(bot: BotRow): Promise<AnswerBot> {
  return {
    id: bot.id,
    name: bot.name,
    audience: bot.audience,
    showName: bot.showName,
    tone: bot.tone,
    personality: bot.personality,
    emoji: bot.emoji,
    quality: bot.quality,
    rules: bot.rules,
    knowledgeBaseIds: await knowledgeBaseIdsFor(bot.id),
    requestTypes: bot.requestTypes,
  };
}
