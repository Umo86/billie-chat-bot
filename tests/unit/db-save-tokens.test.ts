import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { aiUsage, answerCache, bots, settings } from "@/lib/db/schema";
import { rateMessage, visitorMessage } from "@/lib/conversations/service";
import { botById } from "@/lib/bots/load";
import { structured } from "@/lib/ai/provider";
import { pruneReused } from "@/lib/ai/reuse";
import { reusableQuestion, tidyQuestion } from "@/lib/ai/reuse-rules";
import { londonDate } from "@/lib/time";
import { addAndRead, hasDb, makeBot, makeUser } from "../helpers/db";

// Watch which models are asked, while the stand-in AI still answers.
vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/provider")>();
  return { ...real, structured: vi.fn(real.structured) };
});
const calls = vi.mocked(structured);

describe("tidying questions to match them", () => {
  it("ignores case, punctuation, greetings and thanks", () => {
    expect(tidyQuestion("Hi, when does build-up start?")).toBe("when does build up start");
    expect(tidyQuestion("When does build up start")).toBe("when does build up start");
    expect(tidyQuestion("Hello there! When does build-up start? Thanks")).toBe(
      "when does build up start",
    );
    expect(tidyQuestion("What's the Wi-Fi password, please")).toBe("whats the wi fi password");
  });

  it("doesn't keep questions with someone's details, or ones too short to mean much", () => {
    expect(reusableQuestion("When does build-up start?")).toBe(true);
    expect(reusableQuestion("I'm sam@acme.test, when do we build?")).toBe(false);
    expect(reusableQuestion("Call me on 07700 900123 about parking")).toBe(false);
    expect(reusableQuestion("Hi!")).toBe(false);
  });
});

async function botWithKnowledge(quality: "fast" | "thorough") {
  const admin = await makeUser("admin");
  const { bot, kb } = await makeBot({ name: `Token Bot ${quality}` });
  await db.update(bots).set({ quality }).where(eq(bots.id, bot.id));
  await addAndRead(admin, kb.id, {
    kind: "qa",
    question: "When does build-up start?",
    answer: "Build-up starts on Monday 8 March at 8am.",
  });
  return { admin, kb, bot: (await botById(bot.id))! };
}

async function usage(botId: string, model: string) {
  const [row] = await db
    .select()
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.day, londonDate()),
        eq(aiUsage.scope, `bot:${botId}`),
        eq(aiUsage.model, model),
      ),
    );
  return row?.requests ?? 0;
}

describe.skipIf(!hasDb)("saving tokens", () => {
  beforeEach(async () => {
    calls.mockClear();
    await db.update(settings).set({ tryFastFirst: true, reuseAnswers: true });
  });
  afterAll(async () => {
    await db.update(settings).set({ tryFastFirst: true, reuseAnswers: true });
  });

  it("gives the same answer again to the same first question, without Claude", async () => {
    const { bot } = await botWithKnowledge("fast");
    const first = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "When does build-up start?",
    });
    const answer = first.messages.at(-1)!;
    expect(answer.text).toContain("Monday 8 March at 8am");
    expect(calls).toHaveBeenCalledTimes(1);

    // Someone else, typed differently: no call to Claude, the same answer and sources.
    const again = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "hi, when does build up start",
    });
    expect(again.messages.at(-1)).toMatchObject({ text: answer.text, sources: answer.sources });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await usage(bot.id, "reused")).toBe(1);

    // On WhatsApp it's worked out on its own (no forms there).
    await visitorMessage({
      bot,
      conversation: null,
      channel: "whatsapp",
      waId: "447700900001",
      text: "When does build-up start?",
    });
    expect(calls).toHaveBeenCalledTimes(2);

    // Not on the try page, where the team tests the bot.
    await visitorMessage({
      bot,
      conversation: null,
      channel: "try",
      text: "When does build-up start?",
    });
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it("asks Claude again for follow-ups, changed knowledge, unhelpful answers, and when it's off", async () => {
    const { admin, kb, bot } = await botWithKnowledge("fast");
    const ask = () =>
      visitorMessage({
        bot,
        conversation: null,
        channel: "web",
        text: "When does build-up start?",
      });
    const first = await ask();
    await ask();
    expect(calls).toHaveBeenCalledTimes(1);

    // A follow-up depends on the chat so far: always Claude.
    const conv = await db.query.conversations.findFirst({
      where: (c, { eq }) => eq(c.id, first.conversationId),
    });
    await visitorMessage({
      bot,
      conversation: conv!,
      channel: "web",
      text: "When does build-up start?",
    });
    expect(calls).toHaveBeenCalledTimes(2);

    // New knowledge: the earlier answer could be out of date.
    await addAndRead(admin, kb.id, {
      kind: "qa",
      question: "Where do we park?",
      answer: "Park in the orange car park.",
    });
    const fresh = await ask();
    expect(calls).toHaveBeenCalledTimes(3);
    await ask();
    expect(calls).toHaveBeenCalledTimes(3);

    // Marked unhelpful: never given again.
    await rateMessage(fresh.conversationId, fresh.messages.at(-1)!.id, -1);
    await ask();
    expect(calls).toHaveBeenCalledTimes(4);

    // Switched off in Settings → AI.
    await db.update(settings).set({ reuseAnswers: false });
    await ask();
    await ask();
    expect(calls).toHaveBeenCalledTimes(6);
  });

  it("never keeps an answer that needed a person", async () => {
    const { bot } = await botWithKnowledge("fast");
    const ask = () =>
      visitorMessage({
        bot,
        conversation: null,
        channel: "web",
        text: "Can I bring my dog to the stand?",
      });
    await ask();
    await ask();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(await db.select().from(answerCache).where(eq(answerCache.botId, bot.id))).toHaveLength(
      0,
    );
  });

  it("tries the Fast model first for Thorough bots, and the Thorough one only when it isn't sure", async () => {
    const { bot } = await botWithKnowledge("thorough");
    await visitorMessage({
      bot,
      conversation: null,
      channel: "try",
      text: "When does build-up start?",
    });
    expect(calls.mock.calls.map(([c]) => c.model)).toEqual(["claude-haiku-5-5"]);

    // The stand-in doesn't know this one, so the Thorough model gets its go.
    calls.mockClear();
    await visitorMessage({
      bot,
      conversation: null,
      channel: "try",
      text: "Can I bring my dog to the stand?",
    });
    expect(calls.mock.calls.map(([c]) => c.model)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ]);

    // Off: straight to the Thorough model.
    calls.mockClear();
    await db.update(settings).set({ tryFastFirst: false });
    await visitorMessage({
      bot,
      conversation: null,
      channel: "try",
      text: "When does build-up start?",
    });
    expect(calls.mock.calls.map(([c]) => c.model)).toEqual(["claude-sonnet-5-5"]);

    // Fast bots only ever use the Fast model.
    calls.mockClear();
    await db.update(settings).set({ tryFastFirst: true });
    const fast = await botWithKnowledge("fast");
    await visitorMessage({
      bot: fast.bot,
      conversation: null,
      channel: "try",
      text: "Can I bring my dog to the stand?",
    });
    expect(calls.mock.calls.map(([c]) => c.model)).toEqual(["claude-haiku-5-5"]);
  });

  it("clears answers kept from before yesterday", async () => {
    const { bot } = await botWithKnowledge("fast");
    await db.insert(answerCache).values({
      key: `old-${bot.id}`,
      botId: bot.id,
      day: "2020-01-01",
      answer: {},
      answerHash: "x",
    });
    expect(await pruneReused()).toBeGreaterThanOrEqual(1);
    expect(
      await db
        .select()
        .from(answerCache)
        .where(eq(answerCache.key, `old-${bot.id}`)),
    ).toHaveLength(0);
  });
});
