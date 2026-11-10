import "server-only";
import type {
  AnswerMeta,
  BotLink,
  BotRules,
  HandoverKind,
  MessageSource,
  RequestType,
} from "@/lib/types";
import { suspiciousLine } from "@/lib/chat/safety";
import { retrieve } from "@/lib/knowledge/search";
import { answerJsonSchema, answerSchema, type AnswerFlag } from "./schemas";
import { answerSystem, answerUser, knowledgeBlock, type PromptPassage, type Turn } from "./prompts";
import { modelsFor } from "./chosen";
import { AiError, structured, type StructuredResult } from "./provider";
import { aiLimit, limitError, recordUsage } from "./usage";
import { costMicros } from "./pricing";
import { keepForReuse, reuseKey, takeReused } from "./reuse";
import { getSettings } from "@/lib/settings";

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
  personality: string;
  emoji: boolean;
  answerLength: "short" | "normal" | "detailed";
  useName: boolean;
  avoidWords: string;
  quality: "fast" | "thorough";
  rules: BotRules;
  knowledgeBaseIds: string[];
  /** Requests it can take as a form; empty where a form can't be shown (WhatsApp). */
  requestTypes: RequestType[];
  /** Exhibitors can sign in for answers from their own record (not on WhatsApp). */
  personal: boolean;
  /** How: the chat's "Your stand" button, or only by opening the chat from the exhibitor manual. */
  signInBy?: "button" | "manual";
  /** The event team's email (Look step), for suspicious chats and anyone who needs the team. */
  contactEmail: string;
  /** The team's links it can show as buttons; empty where buttons can't be shown (WhatsApp). */
  links: BotLink[];
};

export type AnswerResult = {
  answer: string;
  sources: MessageSource[];
  handover: HandoverKind;
  confident: boolean;
  topic: string;
  /** The request form to show under the answer, if the person wants to make one. */
  request: string | null;
  /** The team's links to show as buttons under the answer. */
  links: BotLink[];
  /** off_topic: not about the show; suspicious: a trick, abuse or fraud (lib/chat/safety.ts). */
  flag: AnswerFlag;
  meta: AnswerMeta;
};

/** If Claude's reply came back empty: kind, and says what happens next. */
export const NO_ANSWER = "Sorry, I don't have the answer to that one yet. The team can help.";

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
  /** Who asked: visitors stop earlier, keeping some of the daily cap for the team. */
  from?: "visitor" | "staff";
  /** A signed-in exhibitor's own record (lib/exhibitors). */
  person?: { record: string } | null;
  /** Visitors' chats: a first question asked again can get the earlier answer (lib/ai/reuse.ts). */
  reuse?: "web" | "whatsapp" | null;
}): Promise<AnswerResult> {
  const { bot, history, question } = input;

  // Asked before today, as a chat's first question: the same answer, no tokens.
  const first = !history.some((t) => t.role === "visitor" || t.role === "agent");
  const reuse =
    input.reuse && first && !input.person ? await reuseKey(bot, question, input.reuse) : null;
  if (reuse) {
    const again = await takeReused(reuse);
    if (again)
      return {
        ...again,
        // Kept before links and flags existed: none.
        links: again.links ?? [],
        flag: again.flag ?? "none",
        meta: {
          handover: again.handover,
          confident: again.confident,
          topic: again.topic,
          model: "reused",
          reused: true,
        },
      };
  }

  if (input.countUsage !== false) {
    // Over a limit: the chat offers the team instead (see aiFailureLine).
    const limit = await aiLimit(input.from ?? "staff");
    if (limit) throw limitError(limit);
  }

  // Recent questions add context to short follow-ups ("and on Sunday?").
  const context = history
    .filter((t) => t.role === "visitor")
    .slice(-2)
    .map((t) => t.text)
    .join(" ");
  const found = await retrieve(bot.knowledgeBaseIds, `${question} ${context}`.trim());
  // Their own record goes last, with the message (not in the cached knowledge).
  const record: PromptPassage | null = input.person?.record
    ? {
        sourceId: "",
        sourceTitle: "Your exhibitor record",
        label: "",
        text: input.person.record,
        kind: "text",
      }
    : null;
  const passages = record ? [...found, record] : found;

  const call = {
    purpose: "answer" as const,
    system: answerSystem({
      name: bot.name,
      audience: bot.audience,
      showName: bot.showName,
      tone: bot.tone,
      personality: bot.personality,
      emoji: bot.emoji,
      answerLength: bot.answerLength,
      useName: bot.useName,
      avoidWords: bot.avoidWords,
      alwaysHuman: bot.rules.alwaysHuman,
      requests: bot.requestTypes.map((r) => ({ id: r.id, name: r.name, when: r.when })),
      personal: bot.personal,
      signInBy: bot.signInBy,
      contactEmail: bot.contactEmail,
      links: bot.links.map((l) => ({ id: l.id, label: l.label, when: l.when })),
    }),
    knowledge: knowledgeBlock(found),
    user: answerUser(
      history,
      question,
      new Date(),
      record ? { n: passages.length, text: record.text } : undefined,
    ),
    schema: answerJsonSchema,
    maxTokens: bot.quality === "thorough" ? 1200 : 700,
    fake: {
      purpose: "answer" as const,
      question,
      passages,
      alwaysHuman: bot.rules.alwaysHuman,
      requests: bot.requestTypes.map((r) => ({ id: r.id, name: r.name })),
      links: bot.links.map((l) => ({ id: l.id, label: l.label })),
    },
  };

  // Thorough bots try the cheaper Fast model first, and ask the Thorough one
  // only when that isn't sure (Settings → AI).
  const thorough = await modelsFor(bot.quality);
  const plan =
    bot.quality === "thorough" && (await getSettings()).tryFastFirst
      ? [await modelsFor("fast"), thorough]
      : [thorough];

  let chosen: { result: StructuredResult; reply: Reply } | null = null;
  let cost = 0;
  for (let i = 0; i < plan.length; i++) {
    const last = i === plan.length - 1;
    let result: StructuredResult;
    try {
      result = await structured({ ...call, ...plan[i] });
    } catch (err) {
      // The cheaper try failing (busy, or a reply in the wrong shape) isn't the end.
      if (!last && err instanceof AiError && err.code !== "refused") continue;
      throw err;
    }
    if (input.countUsage !== false) {
      await recordUsage(`bot:${bot.id}`, result.usage, result.model).catch((err) =>
        console.error("usage not recorded", err instanceof Error ? err.message : err),
      );
    }
    cost += costMicros(result.model, billedOf(result.usage)) ?? 0;
    const reply = readReply(result.json, bot, passages.length);
    if (!reply) {
      if (!last) continue;
      throw new AiError("invalid_output", "The reply didn't match the expected shape");
    }
    chosen = { result, reply };
    const unsure = reply.handover === "unknown" || !reply.confident;
    // Sure enough, or already the Thorough model (the Fast one was busy and fell back to it).
    if (!unsure || last || sameModel(result.model, thorough.model)) break;
  }
  const { result, reply } = chosen!;
  const suspicious = reply.flag === "suspicious";
  // A suspicious message gets the fixed reply: nothing Claude wrote for it is shown.
  const handover = suspicious ? "none" : reply.handover;
  const { used, answer, request } = reply;

  const out: AnswerResult = {
    answer: suspicious ? suspiciousLine(bot.contactEmail) : answer || NO_ANSWER,
    sources: handover === "none" && !suspicious ? citeSources(used, passages) : [],
    handover,
    confident: suspicious ? true : reply.confident,
    topic: suspicious ? "Suspicious message" : reply.topic,
    request: handover === "none" && !suspicious ? request : null,
    links: suspicious ? [] : reply.links,
    flag: reply.flag,
    meta: {
      ...(reply.flag !== "none" ? { flag: reply.flag } : {}),
      handover,
      confident: suspicious ? true : reply.confident,
      topic: suspicious ? "Suspicious message" : reply.topic,
      model: result.model,
      latencyMs: result.latencyMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedTokens: result.usage.cachedTokens,
      passages: passages.length,
    },
  };
  // Only ordinary answers are given again: never a refusal meant for one person.
  if (reuse && reply.flag === "none")
    await keepForReuse(
      reuse,
      out,
      cost,
      passages.map((p) => p.text),
    ).catch(() => undefined);
  return out;
}

type Reply = {
  handover: HandoverKind;
  used: number[];
  answer: string;
  confident: boolean;
  topic: string;
  request: string | null;
  links: BotLink[];
  flag: AnswerFlag;
};

/** Claude's reply, checked: only passages that exist, only requests and links the bot has. */
function readReply(json: unknown, bot: AnswerBot, passageCount: number): Reply | null {
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) return null;
  const r = parsed.data;
  const used = r.used.filter((n) => Number.isInteger(n) && n >= 1 && n <= passageCount);
  let handover: HandoverKind = r.handover;
  const answer = r.answer.trim().slice(0, 4000);
  if (!answer) handover = "unknown";
  // Only a request this bot really has; making one is not a reason to hand over.
  const request = bot.requestTypes.some((t) => t.id === r.request) ? r.request : null;
  if (request && handover !== "always_human" && handover !== "asked_for_person") handover = "none";
  // Only the team's own links, at most two, each once.
  const links = [...new Set(r.links)]
    .map((id) => bot.links.find((l) => l.id === id))
    .filter((l): l is BotLink => Boolean(l))
    .slice(0, 2);
  return {
    handover,
    used,
    answer,
    confident: r.confident,
    topic: r.topic.slice(0, 60),
    request,
    links,
    flag: r.flag,
  };
}

const billedOf = (u: StructuredResult["usage"]) => ({
  input: Math.max(0, u.inputTokens - u.cachedTokens - u.cacheWriteTokens),
  cacheWrite: u.cacheWriteTokens,
  cacheRead: u.cachedTokens,
  output: u.outputTokens,
});

/** The same model, allowing for dated versions ("claude-sonnet-5-5-20261015"). */
function sameModel(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

/** What the person sees when Claude can't be reached; the chat is then offered to the team. */
export function aiFailureLine(err: unknown): string {
  if (err instanceof AiError && err.code === "refused")
    return "Sorry, I can't help with that message.";
  return "Sorry, I can't answer right now.";
}
