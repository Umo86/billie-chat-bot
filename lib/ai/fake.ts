/**
 * Deterministic stand-in for Claude (AI_PROVIDER=fake): tests, CI and demos
 * without an API key. It follows the same contract — answer only from the
 * passages, hand over for always-human topics and requests for a person,
 * decline off-topic questions — with simple keyword matching. Never used on
 * Vercel production (lib/config.ts).
 */
import type { AnswerJson, EmailDraftJson, EmailTagJson } from "./schemas";
import type { FakeContext } from "./provider";
import type { PromptPassage } from "./prompts";
import { searchTerms } from "@/lib/knowledge/rank";

const PERSON =
  /\b(human|person|someone real|real person|agent|speak to|talk to|call me|the team)\b/i;
const OFF_TOPIC = /\b(football|weather|joke|poem|bitcoin|recipe|homework)\b/i;

const TOPIC_WORDS: Record<string, RegExp> = {
  "Payments and refunds": /\b(refund|payment|pay|invoice|money back|charge)/i,
  Complaints: /\b(complain|complaint|unhappy|disappointed)/i,
  "Accidents and injuries": /\b(accident|injur|hurt|first aid)/i,
  "Contract or stand-space changes": /\b(contract|stand space|move our stand|change our stand)/i,
};

function alwaysHumanHit(text: string, topics: string[]): boolean {
  return topics.some((t) => {
    const re = TOPIC_WORDS[t];
    if (re) return re.test(text);
    // A custom topic matches when its first meaningful word appears.
    const word = searchTerms(t)[0];
    return word ? new RegExp(`\\b${word}`, "i").test(text) : false;
  });
}

function bestPassage(
  query: string,
  passages: PromptPassage[],
): { index: number; sentences: string } | null {
  const terms = searchTerms(query);
  if (!terms.length) return null;
  let best = -1;
  let bestScore = 0;
  passages.forEach((p, i) => {
    const words = new Set(searchTerms(`${p.sourceTitle} ${p.label} ${p.text}`, 400));
    let score = 0;
    for (const t of terms) if (words.has(t)) score += t.length > 3 ? 2 : 1;
    if (p.kind === "qa") score *= 1.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  const need = Math.min(2, terms.length);
  if (best < 0 || bestScore < need) return null;
  const text = passages[best].text.replace(/^Q:.*\n?A:\s*/s, "");
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => searchTerms(s, 100).some((w) => terms.includes(w)));
  return { index: best, sentences: (sentences.length ? sentences : [text]).slice(0, 3).join(" ") };
}

function fakeAnswer(
  question: string,
  passages: PromptPassage[],
  alwaysHuman: string[],
): AnswerJson {
  if (PERSON.test(question)) {
    return {
      answer: "Of course. I'll get someone from the team.",
      used: [],
      confident: true,
      handover: "asked_for_person",
      topic: "Speak to a person",
    };
  }
  if (alwaysHumanHit(question, alwaysHuman)) {
    return {
      answer: "The team handles this personally, so I'll pass it to them.",
      used: [],
      confident: true,
      handover: "always_human",
      topic: "Always a person",
    };
  }
  if (OFF_TOPIC.test(question)) {
    return {
      answer: "Sorry, I can only help with questions about the show.",
      used: [],
      confident: true,
      handover: "none",
      topic: "Off topic",
    };
  }
  const hit = bestPassage(question, passages);
  if (!hit) {
    return {
      answer: "I don't have that information yet.",
      used: [],
      confident: false,
      handover: "unknown",
      topic: "Unknown",
    };
  }
  return {
    answer: hit.sentences,
    used: [hit.index + 1],
    confident: true,
    handover: "none",
    topic: passages[hit.index].sourceTitle.slice(0, 40),
  };
}

const EMAIL_TOPIC_RULES: [EmailTagJson["topic"], RegExp][] = [
  ["Payments", /\b(refund|payment|invoice|pay)\b/i],
  ["Complaints", /\b(complain|complaint)/i],
  ["Deliveries", /\b(deliver|courier|delivery|deliveries)/i],
  ["Badges", /\bbadges?\b/i],
  ["Furniture", /\b(furniture|stool|chair|table)/i],
  ["Vehicles and parking", /\b(parking|vehicle|van|car park)/i],
  ["Electrics and services", /\b(electric|power|wifi|internet)/i],
  ["Health and safety", /\b(safety|risk assessment|injur)/i],
  ["Stand build", /\b(build|stand design|shell scheme|space only)/i],
  ["Sponsorship", /\bsponsor/i],
];

function fakeTag(ctx: Extract<FakeContext, { purpose: "email_tag" }>): EmailTagJson {
  const text = `${ctx.email.subject}\n${ctx.email.body}`;
  const topic = EMAIL_TOPIC_RULES.find(([, re]) => re.test(text))?.[0] ?? "Other";
  const stand = /\bstand\s+([A-Z]{1,2}\d{0,2}-?\d{1,4})/i.exec(text)?.[1] ?? "";
  const company =
    ctx.email.body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /\b(ltd|limited|co|plc|llp|inc)\b\.?/i.test(l)) ?? "";
  return {
    topic,
    company: company.slice(0, 80),
    stand: stand.toUpperCase(),
    urgency: /\b(urgent|asap|today)\b/i.test(text) ? "high" : "normal",
    always_human: alwaysHumanHit(text, ctx.alwaysHuman),
    summary: `They ask about ${topic.toLowerCase()}.`,
  };
}

function fakeDraft(ctx: Extract<FakeContext, { purpose: "email_draft" }>): EmailDraftJson {
  const first = ctx.email.fromName.trim().split(/\s+/)[0] || "there";
  // The subject says what the email is about; the body adds detail.
  const hit = bestPassage(
    `${ctx.email.subject} ${ctx.email.subject} ${ctx.email.body}`,
    ctx.passages,
  );
  if (!hit) {
    return {
      draft: "",
      used: [],
      confident: false,
      missing: ctx.email.subject,
      holding: `Hi ${first},\n\nThanks for your email. The team is checking this and will come back to you shortly.\n\n${ctx.signature}`,
    };
  }
  return {
    draft: `Hi ${first},\n\nThanks for your email. ${hit.sentences}\n\n${ctx.signature}`,
    used: [hit.index + 1],
    confident: true,
    missing: "",
    holding: "",
  };
}

export function fakeStructured(ctx: FakeContext): unknown {
  switch (ctx.purpose) {
    case "answer":
      return fakeAnswer(ctx.question, ctx.passages, ctx.alwaysHuman);
    case "email_tag":
      return fakeTag(ctx);
    case "email_draft":
      return fakeDraft(ctx);
  }
}
