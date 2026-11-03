import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { aiUsage, jobs, settings } from "@/lib/db/schema";
import { budgetCard, budgetNow, checkBudget, monthStart } from "@/lib/ai/budget";
import { aiLimit } from "@/lib/ai/usage";
import { answerQuestion } from "@/lib/ai/answer";
import { AiError } from "@/lib/ai/provider";
import { visitorMessage } from "@/lib/conversations/service";
import { answerBotFor, botById } from "@/lib/bots/load";
import { setDirectLink } from "@/lib/alerts/direct";
import { londonDate } from "@/lib/time";
import { addAndRead, hasDb, makeBot, makeUser } from "../helpers/db";
import { DIRECT } from "../helpers/microsoft";

describe("the monthly budget", () => {
  it("counts from the first of the UK month", () => {
    expect(monthStart("2026-11-03")).toBe("2026-11-01");
  });

  it("says what happens at 80% and at 100%", () => {
    const b = {
      month: "2026-11",
      budgetMicros: 50_000_000,
      spentMicros: 41_000_000,
      pct: 82,
      hardStop: true,
      stopped: false,
    };
    const at80 = JSON.stringify(budgetCard(b, 80));
    expect(at80).toContain("Claude has used 80% of this month's budget");
    expect(at80).toContain("Billie has used $41.00 of the $50.00 budget for November.");
    expect(at80).toContain("At 100%, Billie stops using Claude");
    const at100 = JSON.stringify(budgetCard({ ...b, hardStop: false, pct: 104 }, 100));
    expect(at100).toContain("Claude's monthly budget is used up");
    expect(at100).toContain("Billie keeps answering.");
    expect(at100).toContain("/settings?tab=ai");
  });
});

describe.skipIf(!hasDb)("the monthly budget (Postgres)", () => {
  const today = londonDate();
  // Other tests' usage is in the same database: everything here is on top of it.
  let base = 0;
  const spend = (micros: number, day = today) =>
    db.insert(aiUsage).values({
      day,
      scope: `budget-test:${randomUUID()}`,
      model: "claude-haiku-5-5",
      requests: 1,
      costMicros: micros,
    });
  /** A budget in cents that `extra` more micro-dollars would use `pct`% of. */
  const budgetFor = (extra: number, pct: number) =>
    Math.round((base + extra) / (pct / 100) / 10_000);

  beforeAll(async () => {
    base = (await budgetNow()).spentMicros;
  });
  afterAll(() =>
    db
      .update(settings)
      .set({ monthlyBudgetCents: null, budgetHardStop: false, teamsDmWebhookUrl: null }),
  );

  it("counts this month's cost, and stops Claude at the budget only with the stop on", async () => {
    await spend(2_000_000);
    await spend(9_000_000, "2020-01-15"); // another month: not counted
    expect((await budgetNow()).spentMicros).toBe(base + 2_000_000);

    await db
      .update(settings)
      .set({ monthlyBudgetCents: budgetFor(2_000_000, 100), budgetHardStop: false });
    expect(await budgetNow()).toMatchObject({ pct: 100, stopped: false });
    expect(await aiLimit("visitor")).toBeNull(); // over, but the stop is off: still answering

    await db.update(settings).set({ budgetHardStop: true });
    expect(await budgetNow()).toMatchObject({ stopped: true });
    expect(await aiLimit("visitor")).toBe("monthly");
    expect(await aiLimit("staff")).toBe("monthly");

    // Chats go to the team instead.
    const admin = await makeUser("admin");
    const { bot: made, kb } = await makeBot({ name: "Budget Bot" });
    await addAndRead(admin, kb.id, {
      kind: "qa",
      question: "When does build-up start?",
      answer: "Build-up starts on Monday 8 March at 8am.",
    });
    const bot = (await botById(made.id))!;
    await expect(
      answerQuestion({
        bot: await answerBotFor(bot),
        history: [],
        question: "When does build-up start?",
      }),
    ).rejects.toThrow(new AiError("cap_reached", "This month's Claude budget has been reached"));
    const turn = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "When does build-up start?",
    });
    expect(turn.messages.at(-1)?.text).toMatch(/I can pass your question to the team/);
    expect(turn.offer).toEqual({ reason: "ai_unavailable" });

    // A bigger budget lets it answer again.
    await db.update(settings).set({ monthlyBudgetCents: budgetFor(2_000_000, 50) });
    expect(await aiLimit("visitor")).toBeNull();
  });

  it("messages admins in Teams at 80% and at 100%, once each a month", async () => {
    const admin = await makeUser("admin");
    const editor = await makeUser("editor"); // not an admin: no message
    await setDirectLink(admin, DIRECT);
    const keys = async (email: string) =>
      (
        await db
          .select({ key: jobs.dedupeKey })
          .from(jobs)
          .where(and(eq(jobs.kind, "teams_direct"), like(jobs.dedupeKey, `dm:budget:%:${email}`)))
      ).map((j) => j.key);
    const before = (await keys(admin.email)).length;

    await spend(1_700_000);
    const now = (await budgetNow()).spentMicros;
    const cents = Math.round(now / 0.85 / 10_000); // what's been spent so far is about 85% of it
    const budget = cents * 10_000;
    await db.update(settings).set({ monthlyBudgetCents: cents, budgetHardStop: false });
    expect(await checkBudget()).toBeGreaterThanOrEqual(1);
    await checkBudget(); // every 15 minutes: still once
    const month = today.slice(0, 7);
    expect((await keys(admin.email)).slice(before)).toEqual([
      `dm:budget:${month}:${budget}:80:${admin.email}`,
    ]);

    // Past 100%: the second message, and only that one.
    await spend(budget - now + 1_000);
    await checkBudget();
    expect((await keys(admin.email)).slice(before)).toEqual([
      `dm:budget:${month}:${budget}:80:${admin.email}`,
      `dm:budget:${month}:${budget}:100:${admin.email}`,
    ]);
    expect(await keys(editor.email)).toEqual([]);

    // A bigger budget sets the messages up again.
    await db.update(settings).set({ monthlyBudgetCents: cents * 2 });
    await checkBudget();
    expect((await keys(admin.email)).slice(before)).toHaveLength(2);
  });
});
