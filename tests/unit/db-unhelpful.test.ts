import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  auditLog,
  bots,
  conversations,
  messages,
  settings,
  sources,
  unhelpfulAnswers,
} from "@/lib/db/schema";
import { rateMessage, visitorMessage } from "@/lib/conversations/service";
import { botById } from "@/lib/bots/load";
import {
  dismissUnhelpful,
  fixUnhelpful,
  openUnhelpful,
  recordUnhelpful,
} from "@/lib/knowledge/unhelpful";
import { addAndRead, hasDb, makeBot, makeUser } from "../helpers/db";

async function botWithAnswer() {
  const admin = await makeUser("admin");
  const { bot, kb } = await makeBot({ name: "Unhelpful Bot" });
  await addAndRead(admin, kb.id, {
    kind: "qa",
    question: "When does build-up start?",
    answer: "Build-up starts on Monday 8 March at 8am.",
  });
  return { admin, kb, bot: (await botById(bot.id))! };
}

type Bot = NonNullable<Awaited<ReturnType<typeof botById>>>;

/** A visitor asks; returns the chat and Billie's answer. */
async function ask(bot: Bot, text = "When does build-up start?") {
  const turn = await visitorMessage({ bot, conversation: null, channel: "web", text });
  return { conversationId: turn.conversationId, answerId: turn.messages.at(-1)!.id };
}

async function rowFor(botId: string) {
  return db.query.unhelpfulAnswers.findFirst({ where: eq(unhelpfulAnswers.botId, botId) });
}

describe.skipIf(!hasDb)("answers people found unhelpful", () => {
  // Every chat asks Claude (the stand-in): giving an answer again isn't what's tested here.
  beforeAll(() => db.update(settings).set({ reuseAnswers: false }));
  afterAll(() => db.update(settings).set({ reuseAnswers: true }));

  it("notes the question and answer once per answer, counts other chats, and takes back a change of mind", async () => {
    const { bot } = await botWithAnswer();
    const first = await ask(bot);
    await rateMessage(first.conversationId, first.answerId, -1);
    expect(await rowFor(bot.id)).toMatchObject({
      question: "When does build-up start?",
      answer: expect.stringContaining("Monday 8 March at 8am"),
      count: 1,
      status: "open",
    });

    // Tapping thumbs down again on the same answer doesn't count twice.
    await rateMessage(first.conversationId, first.answerId, -1);
    expect((await rowFor(bot.id))?.count).toBe(1);

    // Someone else, worded a little differently: the same question, counted again.
    const second = await ask(bot, "when does build up start");
    await rateMessage(second.conversationId, second.answerId, -1);
    expect((await rowFor(bot.id))?.count).toBe(2);

    // Changed to thumbs up: a mis-tap, so it comes off.
    await rateMessage(second.conversationId, second.answerId, 1);
    expect((await rowFor(bot.id))?.count).toBe(1);
    await rateMessage(first.conversationId, first.answerId, 1);
    expect((await rowFor(bot.id))?.count).toBe(0);
    expect(await openUnhelpful([bot.id])).toHaveLength(0);
  });

  it("saves the team's fix as a typed answer, and reopens only if the new answer is marked", async () => {
    const { admin, kb, bot } = await botWithAnswer();
    const before = await ask(bot);
    const marked = await ask(bot);
    await rateMessage(marked.conversationId, marked.answerId, -1);
    const [row] = await openUnhelpful([bot.id]);
    expect(row).toMatchObject({ botName: "Unhelpful Bot", count: 1 });

    await fixUnhelpful(
      admin,
      row.id,
      "Build-up starts on Sunday 7 March at 2pm for space-only stands.",
    );
    const typed = await db.query.sources.findFirst({
      where: and(
        eq(sources.knowledgeBaseId, kb.id),
        eq(sources.title, "When does build-up start?"),
        eq(sources.status, "queued"),
      ),
    });
    expect(typed?.kind).toBe("qa");
    expect(typed?.body).toContain("Sunday 7 March at 2pm");
    expect(await rowFor(bot.id)).toMatchObject({ status: "fixed", fixedSourceId: typed!.id });
    expect(await openUnhelpful([bot.id])).toHaveLength(0);
    await expect(fixUnhelpful(admin, row.id, "Again")).rejects.toThrow(/no longer on the list/);

    // A thumbs down on an answer from before the fix changes nothing.
    await rateMessage(before.conversationId, before.answerId, -1);
    expect(await rowFor(bot.id)).toMatchObject({ status: "fixed", count: 1 });

    // One on an answer given after the fix: back on the list, counting afresh.
    const after = await ask(bot);
    await rateMessage(after.conversationId, after.answerId, -1);
    expect(await rowFor(bot.id)).toMatchObject({ status: "open", count: 1 });
  });

  it("keeps a dismissed one dismissed, with a note in the audit log", async () => {
    const { admin, bot } = await botWithAnswer();
    const a = await ask(bot);
    await rateMessage(a.conversationId, a.answerId, -1);
    const [row] = await openUnhelpful([bot.id]);
    await dismissUnhelpful(admin, row.id);
    const b = await ask(bot);
    await rateMessage(b.conversationId, b.answerId, -1);
    expect(await rowFor(bot.id)).toMatchObject({ status: "dismissed", count: 2 });
    expect(await openUnhelpful([bot.id])).toHaveLength(0);
    const audit = await db.query.auditLog.findFirst({
      where: and(
        eq(auditLog.entityId, bot.id),
        eq(auditLog.summary, "Dismissed an answer marked unhelpful"),
      ),
    });
    expect(audit?.actorUserId).toBe(admin.id);
  });

  it("shows each person only their bots' answers, and none from deleted bots", async () => {
    const one = await botWithAnswer();
    const two = await botWithAnswer();
    for (const { bot } of [one, two]) {
      const a = await ask(bot);
      await rateMessage(a.conversationId, a.answerId, -1);
    }
    const mine = await openUnhelpful([one.bot.id]);
    expect(mine.map((r) => r.botId)).toEqual([one.bot.id]);
    const all = (await openUnhelpful(null)).map((r) => r.botId);
    expect(all).toEqual(expect.arrayContaining([one.bot.id, two.bot.id]));

    await db.update(bots).set({ deletedAt: new Date() }).where(eq(bots.id, two.bot.id));
    expect((await openUnhelpful(null)).map((r) => r.botId)).not.toContain(two.bot.id);
  });

  it("skips a message that didn't answer a question, like the welcome", async () => {
    const { bot } = await botWithAnswer();
    const [c] = await db
      .insert(conversations)
      .values({ botId: bot.id, channel: "web" })
      .returning();
    const [m] = await db
      .insert(messages)
      .values({ conversationId: c.id, role: "bot", text: "Hello! Ask me anything about the show." })
      .returning();
    await rateMessage(c.id, m.id, -1);
    await recordUnhelpful({
      botId: bot.id,
      conversationId: c.id,
      answer: m.text,
      answeredAt: m.createdAt,
    });
    expect(await rowFor(bot.id)).toBeUndefined();
  });
});
