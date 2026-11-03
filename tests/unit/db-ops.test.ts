import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { conversations, emailThreads, jobs, settings } from "@/lib/db/schema";
import { backoffMs, claim, enqueue, fail, PermanentJobError, runDueJobs } from "@/lib/jobs/queue";
import { consume } from "@/lib/rate-limit";
import { processEmail } from "@/lib/emails/process";
import { runRetention, retentionCutoff } from "@/lib/privacy/retention";
import { answersToday, capReached, recordUsage } from "@/lib/ai/usage";
import { updateBot } from "@/lib/bots/service";
import { answerBotFor, botById } from "@/lib/bots/load";
import { getSettings } from "@/lib/settings";
import { addAndRead, hasDb, makeBot, makeUser } from "../helpers/db";

describe.skipIf(!hasDb)("job queue (Postgres)", () => {
  it("enqueues once per dedupe key while queued, claims, completes and backs off", async () => {
    const key = `test:${Date.now()}`;
    const a = await enqueue("outlook_sync", { n: 1 }, { dedupeKey: key });
    const b = await enqueue("outlook_sync", { n: 2 }, { dedupeKey: key });
    expect(a).toBeTruthy();
    expect(b).toBeNull();

    const ran: unknown[] = [];
    const result = await runDueJobs(
      { outlook_sync: async (p) => void ran.push(p) },
      { budgetMs: 5000 },
    );
    expect(result.done).toBeGreaterThanOrEqual(1);
    expect(ran).toContainEqual({ n: 1 });
    expect((await db.query.jobs.findFirst({ where: eq(jobs.id, a!) }))?.status).toBe("done");
    // Done, so the same key can be queued again.
    expect(await enqueue("outlook_sync", {}, { dedupeKey: key })).toBeTruthy();
    await runDueJobs({ outlook_sync: async () => {} }, { budgetMs: 5000 });
  });

  it("retries with backoff, and stops at once on a permanent error", async () => {
    const id = (await enqueue("process_email", { x: 1 }))!;
    const [job] = (await claim(50)).filter((j) => j.id === id);
    expect(job.attempts).toBe(1);
    const now = new Date();
    expect(await fail(job, new Error("flaky"), now)).toBe("retry");
    let row = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
    expect(row?.status).toBe("queued");
    expect(row!.runAt.getTime()).toBe(now.getTime() + backoffMs(1));
    expect(await fail({ ...job, attempts: 2 }, new PermanentJobError("bad input"), now)).toBe(
      "failed",
    );
    row = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
    expect(row).toMatchObject({ status: "failed", lastError: "bad input" });
  });
});

describe.skipIf(!hasDb)("rate limits and the daily cap (Postgres)", () => {
  it("counts within a window and starts afresh after it", async () => {
    const key = `ip:${Math.random()}`;
    const rule = { window: 60, max: 2 };
    const t = Date.now();
    expect((await consume(key, rule, t)).allowed).toBe(true);
    expect((await consume(key, rule, t + 1)).allowed).toBe(true);
    const third = await consume(key, rule, t + 2);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(50);
    expect((await consume(key, rule, t + 61_000)).allowed).toBe(true);
  });

  it("stops answering once the day's cap is reached", async () => {
    try {
      await db.update(settings).set({ dailyAnswerCap: 0 });
      expect(await capReached()).toBe(false); // 0 = no cap
      const before = await answersToday();
      await recordUsage("bot:test", { inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
      expect(await answersToday()).toBe(before + 1);
      await db.update(settings).set({ dailyAnswerCap: before + 1 });
      expect(await capReached()).toBe(true);
      // Visitors stop at 85% of the cap; the rest is kept for the team.
      for (let i = 0; i < 10; i++)
        await recordUsage("bot:test", { inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
      const used = await answersToday(); // 11 or more
      // A cap above what's used, whose 85% is at or below it.
      await db.update(settings).set({ dailyAnswerCap: Math.floor(used / 0.85) });
      expect(await capReached("visitor")).toBe(true);
      expect(await capReached("staff")).toBe(false);
    } finally {
      await db.update(settings).set({ dailyAnswerCap: 3000 });
    }
  });
});

describe.skipIf(!hasDb)("email assistant (Postgres, stand-in Claude)", () => {
  it("tags and drafts a reply from the knowledge, with its source", async () => {
    const actor = await makeUser("editor");
    const { bot, kb } = await makeBot();
    await addAndRead(actor, kb.id, {
      kind: "text",
      title: "Deliveries",
      body: "Deliveries during build-up go to the hall loading bays.",
    });
    const [email] = await db
      .insert(emailThreads)
      .values({
        source: "manual",
        botId: bot.id,
        fromName: "Alex Morgan",
        fromEmail: "alex@example.com",
        subject: "Deliveries before build-up",
        body: "We're on stand N3-210. Where do deliveries go?\n\nAlex\nExample Signs Ltd",
      })
      .returning();
    await processEmail(email.id);
    const row = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, email.id) });
    expect(row).toMatchObject({
      status: "draft_ready",
      tags: {
        topic: "Deliveries",
        stand: "N3-210",
        company: "Example Signs Ltd",
        urgency: "normal",
      },
    });
    expect(row?.draft).toMatch(/^Hi Alex,/);
    expect(row?.draft).toContain("loading bays");
    expect(row?.draftSources).toEqual([
      { sourceId: expect.any(String), title: "Deliveries", label: "" },
    ]);
  });

  it("writes in the bot's personality and signs off with its own sign-off", async () => {
    const editor = await makeUser("editor");
    const { bot, kb } = await makeBot();
    await addAndRead(editor, kb.id, {
      kind: "text",
      title: "Deliveries",
      body: "Deliveries during build-up go to the hall loading bays.",
    });
    await updateBot(editor, bot.id, {
      personality: "Calm and practical.",
      emoji: true,
      emailSignOff: "Cheers,\nThe UKCW team",
    });
    expect(await answerBotFor((await botById(bot.id))!)).toMatchObject({
      personality: "Calm and practical.",
      emoji: true,
    });
    const paste = async () =>
      (
        await db
          .insert(emailThreads)
          .values({
            source: "manual",
            botId: bot.id,
            fromName: "Alex Morgan",
            fromEmail: "alex@example.com",
            subject: "Deliveries",
            body: "Where do deliveries go?",
          })
          .returning()
      )[0];
    const own = await paste();
    await processEmail(own.id);
    const a = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, own.id) });
    expect(a?.draft).toMatch(/Cheers,\nThe UKCW team$/);
    // Pasted emails never go to Outlook or Teams.
    const delivered = await db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.kind, "deliver_email_draft"), sql`${jobs.payload}->>'emailId' = ${own.id}`),
      );
    expect(delivered).toHaveLength(0);

    // No sign-off of its own: the company's, from Settings.
    await updateBot(editor, bot.id, { emailSignOff: "" });
    const company = await paste();
    await processEmail(company.id);
    const b = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, company.id) });
    expect(b?.draft.endsWith((await getSettings()).emailSignature)).toBe(true);
  });

  it("never drafts always-human topics", async () => {
    const { bot } = await makeBot();
    const [email] = await db
      .insert(emailThreads)
      .values({
        source: "manual",
        botId: bot.id,
        fromName: "Priya Shah",
        fromEmail: "priya@example.com",
        subject: "Refund please",
        body: "Please refund our furniture order.",
      })
      .returning();
    await processEmail(email.id);
    const row = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, email.id) });
    expect(row).toMatchObject({
      status: "needs_you",
      draft: "",
      needsYouReason: "This topic always goes to a person.",
    });
  });
});

describe.skipIf(!hasDb)("retention (Postgres)", () => {
  it("deletes chats older than the retention period and keeps recent ones", async () => {
    const { bot } = await makeBot();
    const old = new Date();
    old.setMonth(old.getMonth() - 13);
    const [a] = await db
      .insert(conversations)
      .values({ botId: bot.id, channel: "web", lastMessageAt: old })
      .returning();
    const [b] = await db
      .insert(conversations)
      .values({ botId: bot.id, channel: "web" })
      .returning();
    const counts = await runRetention();
    expect(counts.chats).toBeGreaterThanOrEqual(1);
    expect(
      await db.query.conversations.findFirst({ where: eq(conversations.id, a.id) }),
    ).toBeUndefined();
    expect(
      await db.query.conversations.findFirst({ where: eq(conversations.id, b.id) }),
    ).toBeTruthy();
    expect(retentionCutoff(12, new Date("2027-05-13T12:00:00Z")).toISOString().slice(0, 7)).toBe(
      "2026-05",
    );
  });
});
