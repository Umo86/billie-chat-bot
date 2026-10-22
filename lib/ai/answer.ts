import "server-only";
import type { AnswerMeta, BotRules, HandoverKind, MessageSource } from "@/lib/types";
import { retrieve } from "@/lib/knowledge/search";
import { answerSchema } from "./schemas";
import { answerJsonSchema } from "./schemas";
import { answerSystem, answerUser, knowledgeBlock, type PromptPassage, type Turn } from "./prompts";
import { fallbackFor, modelFor } from "./models";
import { AiError, structured } from "./provider";
import { capReached, recordUsage } from "./usage";

/**
 * The answer engine: one function every channel uses (web chat, hosted
 * page, WhatsApp, test console). It finds the passages, asks Claude for a
 * structured reply, checks it, and returns the answer with its sources and
 * whether to hand over. It never invents sources: only passages Claude says
 * it used, and only ones that exist, are shown.
 */
export type AnswerBot = {
  id: string;
  name: string;
  audience: "visitors" | "exhibitors";
  showName: string;
  tone: "friendly" | "formal" | "brief";
  quality: "fast" | "thorough";
  rules: BotRules;
  knowledgeBaseIds: string[];
};

export type AnswerResult = {
  answer: string;
  sources: MessageSource[];
  handover: HandoverKind;
  confident: boolean;
  topic: string;
  meta: AnswerMeta;
};

/** Distinct sources in order, at most four, labelled for display. */
export function citeSources(used: number[], passages: PromptPassage[]): MessageSource[] {
  const seen = new Set<string>();
  const out: MessageSource[] = [];
  for (const n of used) {
    const p = passages[n - 1];
    if (!p) continue;
    const label = p.kind === "qa" ? "Typed answer" : p.label;
    const key = `${p.sourceId}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceId: p.sourceId, title: p.sourceTitle, label });
    if (out.length === 4) break;
  }
  return out;
}

export async function answerQuestion(input: {
  bot: AnswerBot;
  history: Turn[];
  question: string;
  /** Skip usage recording and the cap (test console runs still count; this is for internal checks). */
  countUsage?: boolean;
}): Promise<AnswerResult> {
  const { bot, history, question } = input;
  if (input.countUsage !== false && (await capReached())) {
    throw new AiError("cap_reached", "Today's answer limit has been reached");
  }

  // Recent questions add context to short follow-ups ("and on Sunday?").
  const context = history
    .filter((t) => t.role === "visitor")
    .slice(-2)
    .map((t) => t.text)
    .join(" ");
  const passages = await retrieve(bot.knowledgeBaseIds, `${question} ${context}`.trim());

  const result = await structured({
    purpose: "answer",
    model: modelFor(bot.quality),
    fallbackModel: fallbackFor(bot.quality),
    system: answerSystem({
      name: bot.name,
      audience: bot.audience,
      showName: bot.showName,
      tone: bot.tone,
      alwaysHuman: bot.rules.alwaysHuman,
    }),
    knowledge: knowledgeBlock(passages),
    user: answerUser(history, question),
    schema: answerJsonSchema,
    maxTokens: bot.quality === "thorough" ? 1200 : 700,
    fake: { purpose: "answer", question, passages, alwaysHuman: bot.rules.alwaysHuman },
  });

  const parsed = answerSchema.safeParse(result.json);
  if (!parsed.success) throw new AiError("invalid_output", "The reply didn't match the expected shape");
  const r = parsed.data;

  const used = r.used.filter((n) => Number.isInteger(n) && n >= 1 && n <= passages.length);
  let handover: HandoverKind = r.handover;
  const answer = r.answer.trim().slice(0, 4000);
  if (!answer) handover = "unknown";

  if (input.countUsage !== false) {
    await recordUsage(`bot:${bot.id}`, result.usage).catch((err) =>
      console.error("usage not recorded", err instanceof Error ? err.message : err),
    );
  }

  return {
    answer: answer || "I don't have that information yet.",
    sources: handover === "none" ? citeSources(used, passages) : [],
    handover,
    confident: r.confident,
    topic: r.topic.slice(0, 60),
    meta: {
      handover,
      confident: r.confident,
      topic: r.topic.slice(0, 60),
      model: result.model,
      latencyMs: result.latencyMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedTokens: result.usage.cachedTokens,
      passages: passages.length,
    },
  };
}

/** What the person sees when Claude can't be reached; the chat is then offered to the team. */
export function aiFailureLine(err: unknown): string {
  if (err instanceof AiError && err.code === "refused") return "Sorry, I can't help with that message.";
  return "Sorry, I can't answer right now.";
}
