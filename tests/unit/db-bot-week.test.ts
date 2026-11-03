import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, conversations, emailThreads, gaps, jobs } from "@/lib/db/schema";
import {
  botWeek,
  botWeekCard,
  hoursSaved,
  postBotWeek,
  queueBotWeeks,
} from "@/lib/reports/bot-week";
import { hasDb, makeBot } from "../helpers/db";
import { fakeMicrosoft, TEAMS } from "../helpers/microsoft";

describe("the weekly numbers", () => {
  it("counts 4 minutes per chat Billie answered alone and 8 per drafted email", () => {
    expect(hoursSaved(30, 0)).toBe(2);
    expect(hoursSaved(10, 5)).toBe(1.5);
    expect(hoursSaved(0, 0)).toBe(0);
  });

  it("puts what people wrote in plain text, with a link to answer each new question", () => {
    const card = botWeekCard({
      botName: "IHS Christmas Exhibitor Help",
      k: {
        chats: 40,
        answeredAlonePct: 85,
        handedOver: 6,
        emailsDrafted: 12,
        openGaps: 3,
        helpfulPct: 90,
      },
      top: [{ question: "When can we build? [click](https://evil.test)", times: 9 }],
      newGaps: [{ id: "g1", question: "Is there Wi-Fi in Hall 2?", askCount: 3 }],
      hours: 3.5,
      link: "https://billie.test/reports?days=7",
      gapsLink: "https://billie.test/knowledge?tab=gaps",
    });
    const json = JSON.stringify(card);
    expect(json).toContain(
      "40 chats · 85% answered by Billie alone · 6 passed to the team · 12 email replies drafted",
    );
    expect(json).toContain("About 3.5 hours saved");
    expect(json).toContain("https://billie.test/knowledge?tab=gaps#gap-g1");
    expect(json).toContain("Is there Wi-Fi in Hall 2? (asked 3 times)");
    // The visitor's text is a TextRun, never a Markdown TextBlock.
    expect(json).not.toContain('"type":"TextBlock"');
  });
});

describe.skipIf(!hasDb)("the Monday post in each event's Teams channel (Postgres)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts last week's numbers for bots with their own channel, once", async () => {
    const now = new Date();
    const { bot } = await makeBot({ name: "Week Help" });
    const quiet = await makeBot({ name: "Quiet draft", status: "draft" });
    await db.update(bots).set({ teamsWebhookUrl: TEAMS }).where(eq(bots.id, bot.id));
    await db.update(bots).set({ teamsWebhookUrl: TEAMS }).where(eq(bots.id, quiet.bot.id));
    const day = (n: number) => new Date(now.getTime() - n * 86_400_000);
    await db.insert(conversations).values([
      { botId: bot.id, channel: "web", firstQuestion: "When can we build?", createdAt: day(1) },
      { botId: bot.id, channel: "web", firstQuestion: "When can we build?", createdAt: day(2) },
      {
        botId: bot.id,
        channel: "web",
        firstQuestion: "Refund?",
        handoverAt: day(2),
        createdAt: day(2),
      },
      { botId: bot.id, channel: "try", firstQuestion: "Test chat", createdAt: day(1) },
      { botId: bot.id, channel: "web", firstQuestion: "Old chat", createdAt: day(20) },
    ]);
    await db.insert(emailThreads).values({
      source: "manual",
      botId: bot.id,
      subject: "Build-up",
      body: "When?",
      status: "draft_ready",
    });
    await db.insert(gaps).values([
      {
        botId: bot.id,
        questionKey: `wifi-${randomUUID()}`,
        question: "Is there Wi-Fi in Hall 2?",
        askCount: 3,
      },
      {
        botId: bot.id,
        questionKey: `old-${randomUUID()}`,
        question: "An old question",
        firstAskedAt: day(30),
      },
    ]);

    const week = await botWeek(bot.id, now);
    expect(week?.k).toMatchObject({ chats: 3, handedOver: 1, emailsDrafted: 1 });
    expect(week?.top[0]).toEqual({ question: "When can we build?", times: 2 });
    expect(week?.newGaps.map((g) => g.question)).toEqual(["Is there Wi-Fi in Hall 2?"]);
    expect(week?.hours).toBe(0.5); // 2 chats alone (8 min) + 1 email (8 min)

    await queueBotWeeks(now);
    await queueBotWeeks(now); // a retry of the Monday job queues nothing more
    const queued = await db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.kind, "weekly_bot_summary"), like(jobs.dedupeKey, `bot-week:%:${bot.id}`)),
      );
    expect(queued).toHaveLength(1);
    const notQuiet = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, "weekly_bot_summary"),
          like(jobs.dedupeKey, `bot-week:%:${quiet.bot.id}`),
        ),
      );
    expect(notQuiet).toHaveLength(0); // a draft with no chats posts nothing

    const ms = fakeMicrosoft({});
    vi.stubGlobal("fetch", ms.fetchMock);
    await postBotWeek(bot.id, now);
    const post = ms.calls.find((c) => c.url === TEAMS);
    expect(JSON.stringify(post?.body)).toContain("Week Help: last week");
  });
});
