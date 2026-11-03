import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  bots,
  chatRequests,
  conversations,
  emailThreads,
  gaps,
  jobs,
  messages,
  unhelpfulAnswers,
} from "@/lib/db/schema";
import {
  addDays,
  dayLabel,
  isDay,
  isPostDay,
  rangeLabel,
  showDaysProblem,
} from "@/lib/bots/show-days";
import { postShowDay, queueShowDays, showDay, showDayCard } from "@/lib/reports/show-day";
import { createBot, updateBot } from "@/lib/bots/service";
import { hasDb, makeBot, makeUser } from "../helpers/db";
import { fakeMicrosoft, TEAMS } from "../helpers/microsoft";

describe("show days", () => {
  it("are real dates, in order, a month at most", () => {
    expect(isDay("2027-03-08")).toBe(true);
    expect(isDay("2027-02-30")).toBe(false);
    expect(isDay("8/3/2027")).toBe(false);
    expect(showDaysProblem({ from: "2027-03-08", to: "2027-03-12" })).toBeNull();
    expect(showDaysProblem({ from: "2027-03-12", to: "2027-03-08" })).toMatchObject({
      field: "to",
      message: "The last day can't be before the first.",
    });
    expect(showDaysProblem({ from: "2027-03-08", to: "" })).toMatchObject({ field: "to" });
    expect(showDaysProblem({ from: "2027-03-01", to: "2027-04-15" })?.message).toMatch(
      /31 days or fewer/,
    );
  });

  it("have a morning post on each day, and the day after the last", () => {
    const d = { from: "2027-03-08", to: "2027-03-12" };
    expect(isPostDay(d, "2027-03-07")).toBe(false);
    expect(isPostDay(d, "2027-03-08")).toBe(true);
    expect(isPostDay(d, "2027-03-13")).toBe(true); // covers breakdown day
    expect(isPostDay(d, "2027-03-14")).toBe(false);
    expect(isPostDay(null, "2027-03-10")).toBe(false);
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(dayLabel("2027-03-09")).toBe("Tuesday 9 March");
    expect(rangeLabel(d)).toBe("8 to 12 March 2027");
    expect(rangeLabel({ from: "2027-03-30", to: "2027-04-02" })).toBe("30 March to 2 April 2027");
    expect(rangeLabel({ from: "2026-12-28", to: "2027-01-03" })).toBe(
      "28 December 2026 to 3 January 2027",
    );
  });

  it("make a card in plain text, with a link to fix each problem", () => {
    const card = showDayCard(
      {
        botName: "UKCW Exhibitor Help",
        today: "2027-03-09",
        day: "2027-03-08",
        yesterday: {
          chats: 40,
          alonePct: 85,
          handedOver: 6,
          emails: 12,
          requests: 3,
          unhelpful: 2,
        },
        reasons: [
          { reason: "asked_for_person", n: 4 },
          { reason: "unknown", n: 2 },
        ],
        waiting: { chats: 2, emails: 0, requests: 5 },
        mostAsked: [{ question: "Where is the loading bay? [click](https://evil.test)", times: 9 }],
        couldntAnswer: [{ id: "g1", question: "Is there Wi-Fi in Hall 2?", askCount: 3 }],
        unhelpful: [{ id: "u1", question: "When can we build?", count: 1 }],
      },
      "https://billie.test",
    );
    const json = JSON.stringify(card);
    expect(json).toContain("UKCW Exhibitor Help: Tuesday 9 March");
    expect(json).toContain("Yesterday (Monday 8 March)");
    expect(json).toContain("40 chats · 85% answered by Billie alone · 6 passed to the team");
    expect(json).toContain("12 emails in · 3 new requests · 2 answers marked unhelpful");
    expect(json).toContain(
      "Passed to the team: Asked for a person (4) · Billie didn't have the answer (2)",
    );
    expect(json).toContain("2 chats waiting for a person · 5 open requests");
    expect(json).toContain("https://billie.test/knowledge?tab=gaps#gap-g1");
    expect(json).toContain("https://billie.test/knowledge?tab=gaps#unhelpful-u1");
    expect(json).toContain("Is there Wi-Fi in Hall 2? (asked 3 times)");
    expect(json).toContain('"title":"Open the Inbox"');
    expect(json).toContain('"title":"Open Requests"');
    expect(json).not.toContain('"title":"Open Emails"');
    // What people wrote is a TextRun, never a Markdown TextBlock.
    expect(json).not.toContain('"type":"TextBlock"');

    const quiet = JSON.stringify(
      showDayCard(
        {
          botName: "Quiet",
          today: "2027-03-09",
          day: "2027-03-08",
          yesterday: {
            chats: 0,
            alonePct: null,
            handedOver: 0,
            emails: 0,
            requests: 0,
            unhelpful: 0,
          },
          reasons: [],
          waiting: { chats: 0, emails: 0, requests: 0 },
          mostAsked: [],
          couldntAnswer: [],
          unhelpful: [],
        },
        "https://billie.test",
      ),
    );
    expect(quiet).toContain("No chats.");
    expect(quiet).toContain("Nothing waiting.");
    expect(quiet).not.toContain("To look at");
  });
});

describe.skipIf(!hasDb)("the morning post during show week (Postgres)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("are saved with the bot, and cleared when emptied", async () => {
    const admin = await makeUser("admin");
    const id = await createBot(admin, {
      name: "Days Bot",
      audience: "exhibitors",
      showName: "UKCW 2027",
      color: "#0d6a5b",
      avatarUrl: null,
      welcome: "",
      starters: [],
      showDays: { from: "2027-03-08", to: "2027-03-12" },
    });
    let bot = await db.query.bots.findFirst({ where: eq(bots.id, id) });
    expect([bot?.showStartsOn, bot?.showEndsOn]).toEqual(["2027-03-08", "2027-03-12"]);
    await updateBot(admin, id, { welcome: "Hello" }); // other changes leave them alone
    bot = await db.query.bots.findFirst({ where: eq(bots.id, id) });
    expect(bot?.showStartsOn).toBe("2027-03-08");
    await updateBot(admin, id, { showDays: null });
    bot = await db.query.bots.findFirst({ where: eq(bots.id, id) });
    expect([bot?.showStartsOn, bot?.showEndsOn]).toEqual([null, null]);
  });

  it("counts yesterday (UK time) and what's waiting now, for that bot only", async () => {
    const { bot } = await makeBot({ name: "Show Week Help" });
    const other = await makeBot({ name: "Other" });
    // Summer time: UK midnight on 9 June is 23:00 UTC on 8 June.
    const today = "2027-06-09";
    const at = (iso: string) => new Date(iso);
    const [inside, handed] = await db
      .insert(conversations)
      .values([
        {
          botId: bot.id,
          channel: "web",
          firstQuestion: "Where is the loading bay?",
          createdAt: at("2027-06-07T23:30:00Z"), // 00:30 on the 8th, UK
        },
        {
          botId: bot.id,
          channel: "web",
          firstQuestion: "where is the loading bay",
          handoverAt: at("2027-06-08T10:00:00Z"),
          handoverReason: "asked_for_person",
          status: "waiting",
          createdAt: at("2027-06-08T09:00:00Z"),
        },
        {
          botId: bot.id,
          channel: "web",
          firstQuestion: "Too late",
          createdAt: at("2027-06-08T23:10:00Z"), // 00:10 on the 9th, UK: today
        },
        {
          botId: bot.id,
          channel: "try",
          firstQuestion: "A test",
          createdAt: at("2027-06-08T12:00:00Z"),
        },
        {
          botId: other.bot.id,
          channel: "web",
          firstQuestion: "Elsewhere",
          createdAt: at("2027-06-08T12:00:00Z"),
        },
      ])
      .returning();
    await db.insert(messages).values([
      {
        conversationId: inside.id,
        role: "visitor",
        text: "Where is the loading bay?",
        createdAt: at("2027-06-07T23:30:00Z"),
      },
      {
        conversationId: inside.id,
        role: "bot",
        text: "Gate 3.",
        rating: -1,
        createdAt: at("2027-06-07T23:30:05Z"),
      },
    ]);
    await db.insert(emailThreads).values([
      {
        source: "manual",
        botId: bot.id,
        subject: "Badges",
        body: "?",
        status: "needs_you",
        createdAt: at("2027-06-08T08:00:00Z"),
      },
      {
        source: "manual",
        botId: bot.id,
        subject: "Old",
        body: "?",
        status: "sent",
        createdAt: at("2027-06-01T08:00:00Z"),
      },
    ]);
    await db.insert(chatRequests).values([
      {
        botId: bot.id,
        conversationId: handed.id,
        typeId: "hours",
        typeName: "Extra hours",
        trackToken: randomUUID(),
        createdAt: at("2027-06-08T11:00:00Z"),
      },
      {
        botId: bot.id,
        typeId: "hours",
        typeName: "Extra hours",
        status: "done",
        trackToken: randomUUID(),
        createdAt: at("2027-06-01T11:00:00Z"),
      },
    ]);
    const [gap] = await db
      .insert(gaps)
      .values({
        botId: bot.id,
        questionKey: `wifi-${randomUUID()}`,
        question: "Is there Wi-Fi in Hall 2?",
        askCount: 3,
        lastAskedAt: at("2027-06-08T15:00:00Z"),
      })
      .returning();
    await db.insert(gaps).values({
      botId: bot.id,
      questionKey: `old-${randomUUID()}`,
      question: "An old one",
      lastAskedAt: at("2027-05-01T15:00:00Z"),
    });
    const [bad] = await db
      .insert(unhelpfulAnswers)
      .values({
        botId: bot.id,
        questionKey: `bay-${randomUUID()}`,
        question: "Where is the loading bay?",
        answer: "Gate 3.",
        lastAt: at("2027-06-08T07:00:00Z"),
      })
      .returning();

    const d = (await showDay(bot.id, today))!;
    expect(d.day).toBe("2027-06-08");
    expect(d.yesterday).toEqual({
      chats: 2,
      alonePct: 50,
      handedOver: 1,
      emails: 1,
      requests: 1,
      unhelpful: 1,
    });
    expect(d.reasons).toEqual([{ reason: "asked_for_person", n: 1 }]);
    expect(d.waiting).toEqual({ chats: 1, emails: 1, requests: 1 });
    expect(d.mostAsked).toEqual([{ question: "Where is the loading bay?", times: 2 }]);
    expect(d.couldntAnswer).toEqual([
      { id: gap.id, question: "Is there Wi-Fi in Hall 2?", askCount: 3 },
    ]);
    expect(d.unhelpful).toEqual([{ id: bad.id, question: "Where is the loading bay?", count: 1 }]);
  });

  it("posts each show morning, once, only for bots with show days and a channel", async () => {
    const { bot } = await makeBot({ name: "Posting Help" });
    const noChannel = await makeBot({ name: "No Channel" });
    const notYet = await makeBot({ name: "Not Yet" });
    await db
      .update(bots)
      .set({ teamsWebhookUrl: TEAMS, showStartsOn: "2027-03-08", showEndsOn: "2027-03-12" })
      .where(eq(bots.id, bot.id));
    await db
      .update(bots)
      .set({ showStartsOn: "2027-03-08", showEndsOn: "2027-03-12" })
      .where(eq(bots.id, noChannel.bot.id));
    await db
      .update(bots)
      .set({ teamsWebhookUrl: TEAMS, showStartsOn: "2027-04-01", showEndsOn: "2027-04-03" })
      .where(eq(bots.id, notYet.bot.id));
    const queued = async (botId: string) =>
      db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, "show_day_post"), like(jobs.dedupeKey, `show-day:%:${botId}`)));

    // 07:45 UK on Tuesday 9 March 2027 (GMT).
    const morning = new Date("2027-03-09T07:45:00Z");
    await queueShowDays(morning);
    await queueShowDays(morning); // the tick runs every minute: still once
    expect(await queued(bot.id)).toHaveLength(1);
    expect(await queued(noChannel.bot.id)).toHaveLength(0);
    expect(await queued(notYet.bot.id)).toHaveLength(0);
    // The day after breakdown gets one too; the day after that doesn't.
    await queueShowDays(new Date("2027-03-13T08:00:00Z"));
    await queueShowDays(new Date("2027-03-14T08:00:00Z"));
    expect((await queued(bot.id)).map((j) => j.dedupeKey).sort()).toEqual([
      `show-day:2027-03-09:${bot.id}`,
      `show-day:2027-03-13:${bot.id}`,
    ]);

    const ms = fakeMicrosoft({});
    vi.stubGlobal("fetch", ms.fetchMock);
    await postShowDay(bot.id, "2027-03-09");
    const post = ms.calls.find((c) => c.url === TEAMS);
    expect(JSON.stringify(post?.body)).toContain("Posting Help: Tuesday 9 March");

    // Days moved since it was queued: nothing is posted.
    await db
      .update(bots)
      .set({ showStartsOn: "2027-05-01", showEndsOn: "2027-05-03" })
      .where(eq(bots.id, bot.id));
    ms.calls.length = 0;
    await postShowDay(bot.id, "2027-03-10");
    expect(ms.calls.find((c) => c.url === TEAMS)).toBeUndefined();
  });
});
