import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botKnowledgeBases, bots, knowledgeBases } from "@/lib/db/schema";
import type { AnswerBot } from "@/lib/ai/answer";

export type BotRow = typeof bots.$inferSelect;

export async function knowledgeBaseIdsFor(botId: string): Promise<string[]> {
  const rows = await db
    .select({ id: botKnowledgeBases.knowledgeBaseId })
    .from(botKnowledgeBases)
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, botKnowledgeBases.knowledgeBaseId))
    .where(and(eq(botKnowledgeBases.botId, botId), isNull(knowledgeBases.deletedAt)));
  return rows.map((r) => r.id);
}

export async function botBySlug(slug: string): Promise<BotRow | null> {
  const bot = await db.query.bots.findFirst({ where: and(eq(bots.slug, slug), isNull(bots.deletedAt)) });
  return bot ?? null;
}

export async function botById(id: string): Promise<BotRow | null> {
  const bot = await db.query.bots.findFirst({ where: and(eq(bots.id, id), isNull(bots.deletedAt)) });
  return bot ?? null;
}

export async function answerBotFor(bot: BotRow): Promise<AnswerBot> {
  return {
    id: bot.id,
    name: bot.name,
    audience: bot.audience,
    showName: bot.showName,
    tone: bot.tone,
    quality: bot.quality,
    rules: bot.rules,
    knowledgeBaseIds: await knowledgeBaseIdsFor(bot.id),
  };
}
