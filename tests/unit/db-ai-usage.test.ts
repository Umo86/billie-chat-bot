import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { aiUsage, auditLog, settings, usageDaily } from "@/lib/db/schema";
import { answersToday, recordUsage } from "@/lib/ai/usage";
import { aiUsageReport } from "@/lib/ai/report";
import { modelsFor } from "@/lib/ai/chosen";
import { getSettings, updateSettings } from "@/lib/settings";
import { hasDb, makeBot, makeUser } from "../helpers/db";

// A day nobody else's test uses, in the past.
const DAY = new Date("2026-01-14T12:00:00Z");

describe.skipIf(!hasDb)("Claude usage and cost", () => {
  afterAll(async () => {
    await db.delete(aiUsage).where(inArray(aiUsage.day, ["2026-01-14", "2026-01-15"]));
    await db.update(settings).set({ fastModel: null, thoroughModel: null });
  });

  it("records each call by model, with its cost, and still counts for the daily cap", async () => {
    const { bot } = await makeBot({ name: "Cost Test Bot" });
    const before = await answersToday(DAY);
    // A Sonnet answer that read the knowledge from the cache, and one that wrote it.
    await recordUsage(
      `bot:${bot.id}`,
      { inputTokens: 14_000, cachedTokens: 12_000, cacheWriteTokens: 0, outputTokens: 300 },
      "claude-sonnet-5-5",
      DAY,
    );
    await recordUsage(
      `bot:${bot.id}`,
      { inputTokens: 14_000, cachedTokens: 0, cacheWriteTokens: 12_000, outputTokens: 300 },
      "claude-sonnet-5-5-20261015",
      DAY,
    );
    await recordUsage(
      "email",
      { inputTokens: 1_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
      "claude-haiku-5-5",
      DAY,
    );
    expect(await answersToday(DAY)).toBe(before + 3);

    const rows = await db.select().from(aiUsage).where(eq(aiUsage.day, "2026-01-14"));
    const sonnet = rows.find((r) => r.model === "claude-sonnet-5-5")!;
    expect(sonnet).toMatchObject({
      requests: 1,
      inputTokens: 2_000,
      cacheReadTokens: 12_000,
      cacheWriteTokens: 0,
      outputTokens: 300,
      costMicros: 2_000 * 2 + 12_000 * 0.1 + 300 * 10,
    });
    // The dated version is priced as Sonnet 5.5, and kept as its own row.
    expect(rows.find((r) => r.model === "claude-sonnet-5-5-20261015")?.costMicros).toBe(
      2_000 * 2 + 12_000 * 2.5 + 300 * 10,
    );
    const [daily] = await db
      .select()
      .from(usageDaily)
      .where(eq(usageDaily.scope, `bot:${bot.id}`));
    expect(daily).toMatchObject({ requests: 2, inputTokens: 28_000, cachedTokens: 12_000 });
  });

  it("reports a period by model, by use and by day", async () => {
    const report = await aiUsageReport("today", DAY);
    expect(report.from).toBe("2026-01-14");
    expect(report.days).toHaveLength(1);
    const total =
      2_000 * 2 +
      12_000 * 0.1 +
      300 * 10 +
      (2_000 * 2 + 12_000 * 2.5 + 300 * 10) +
      (1_000 * 0.1 + 100 * 0.5);
    expect(report.totals.cost).toBe(total);
    expect(report.totals.requests).toBe(3);
    expect(report.byModel.map((m) => m.model)).toEqual([
      "claude-sonnet-5-5-20261015",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(report.byScope.map((s) => s.label)).toEqual([
      "Answers: Cost Test Bot",
      "Emails: sorting and drafting replies",
    ]);
    expect(report.unpriced).toBe(0);

    // A week fills the quiet days in.
    const week = await aiUsageReport("7d", new Date("2026-01-17T12:00:00Z"));
    expect(week.days.map((d) => d.day)).toEqual([
      "2026-01-11",
      "2026-01-12",
      "2026-01-13",
      "2026-01-14",
      "2026-01-15",
      "2026-01-16",
      "2026-01-17",
    ]);
    expect(week.days[3].cost).toBe(total);
    expect(week.days[0]).toMatchObject({ cost: 0, requests: 0 });
  });

  it("says which use was from before models were recorded", async () => {
    // As migration 0019 copied it from usage_daily: tokens, no model, no cost.
    await db.insert(aiUsage).values({
      day: "2026-01-15",
      scope: "check",
      model: "",
      requests: 2,
      inputTokens: 5_000,
      outputTokens: 900,
    });
    await recordUsage(
      "check",
      { inputTokens: 1_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
      "claude-sonnet-5-5",
      new Date("2026-01-15T12:00:00Z"),
    );
    const day = await aiUsageReport("today", new Date("2026-01-15T12:00:00Z"));
    expect(day.unpriced).toBe(2);
    expect(day.byScope).toEqual([
      expect.objectContaining({ label: "Knowledge checks", requests: 3, unpriced: 2 }),
    ]);
    expect(day.byModel.map((m) => [m.model, m.requests])).toEqual([
      ["claude-sonnet-5-5", 1],
      ["", 2],
    ]);
  });

  it("uses the models an admin chose, with the other as the backup, and audits it", async () => {
    const admin = await makeUser("admin");
    expect(await modelsFor("thorough")).toEqual({
      model: "claude-sonnet-5-5",
      fallbackModel: "claude-haiku-5-5",
    });
    await updateSettings(
      admin.id,
      { fastModel: "claude-sonnet-5-5", thoroughModel: "claude-opus-5-5" },
      "Chose the AI models: Claude Sonnet 5.5 for fast work, Claude Opus 5.5 for thorough work",
    );
    expect(await modelsFor("thorough")).toEqual({
      model: "claude-opus-5-5",
      fallbackModel: "claude-sonnet-5-5",
    });
    expect(await modelsFor("fast")).toEqual({
      model: "claude-sonnet-5-5",
      fallbackModel: "claude-opus-5-5",
    });
    expect((await getSettings()).thoroughModel).toBe("claude-opus-5-5");
    const audit = await db.select().from(auditLog).where(eq(auditLog.actorUserId, admin.id));
    expect(audit.map((a) => a.summary)).toContain(
      "Chose the AI models: Claude Sonnet 5.5 for fast work, Claude Opus 5.5 for thorough work",
    );
    await db.update(settings).set({ fastModel: null, thoroughModel: null });
  });
});
