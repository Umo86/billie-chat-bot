import { describe, expect, it } from "vitest";
import {
  costMicros,
  modelInfo,
  modelName,
  MODELS,
  priceLine,
  usd,
  usdFine,
} from "@/lib/ai/pricing";
import { periodDates } from "@/lib/ai/report";

const one = { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 };

describe("Claude prices", () => {
  it("works out what a call cost, in millionths of a dollar", () => {
    // A million tokens in costs the price per million.
    expect(costMicros("claude-sonnet-5-5", one)).toBe(2_000_000);
    expect(costMicros("claude-opus-5-5", one)).toBe(4_000_000);
    // A million-token prompt is over Haiku's 100,000 threshold: the higher rate.
    expect(costMicros("claude-haiku-5-5", one)).toBe(500_000);
    // A typical answer: 2,000 tokens in, 12,000 read from the cache, 300 out on Sonnet.
    expect(
      costMicros("claude-sonnet-5-5", {
        input: 2_000,
        cacheWrite: 0,
        cacheRead: 12_000,
        output: 300,
      }),
    ).toBe(2_000 * 2 + 12_000 * 0.1 + 300 * 10);
    // Writing the knowledge to the cache costs a quarter more than reading it fresh.
    expect(
      costMicros("claude-sonnet-5-5", { input: 0, cacheWrite: 10_000, cacheRead: 0, output: 0 }),
    ).toBe(25_000);
  });

  it("charges Haiku 5.5's higher rates for prompts over 100,000 tokens", () => {
    const small = { input: 100_000, cacheWrite: 0, cacheRead: 0, output: 1_000 };
    const big = { input: 100_001, cacheWrite: 0, cacheRead: 0, output: 1_000 };
    expect(costMicros("claude-haiku-5-5", small)).toBe(100_000 * 0.1 + 1_000 * 0.5);
    expect(costMicros("claude-haiku-5-5", big)).toBe(Math.round(100_001 * 0.5 + 1_000 * 2.5));
    // Cache reads count towards the prompt's size.
    expect(
      costMicros("claude-haiku-5-5", {
        input: 1_000,
        cacheWrite: 0,
        cacheRead: 100_000,
        output: 0,
      }),
    ).toBe(1_000 * 0.5 + 100_000 * 0.05);
  });

  it("knows dated versions of a model, and says when it doesn't know one", () => {
    expect(modelInfo("claude-sonnet-5-5-20261015")?.name).toBe("Claude Sonnet 5.5");
    expect(modelInfo("claude-sonnet-5")).toBeNull();
    expect(costMicros("stand-in", one)).toBeNull();
    expect(modelName("")).toBe("Not recorded");
    expect(modelName("stand-in")).toBe("Stand-in (tests)");
    expect(modelName("claude-something-new")).toBe("claude-something-new");
  });

  it("shows dollars plainly", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(4_200)).toBe("$0.0042");
    expect(usd(12_345_678)).toBe("$12.35");
    expect(usd(1_234_000_000)).toBe("$1,234.00");
    expect(MODELS.map(priceLine)).toEqual([
      "$0.10 in, $0.50 out per million tokens",
      "$2 in, $10 out per million tokens",
      "$4 in, $20 out per million tokens",
    ]);
  });

  it("turns a period into UK dates", () => {
    const now = new Date("2026-11-03T23:30:00Z"); // still 3 Nov in London (GMT)
    expect(periodDates("today", now)).toEqual({ from: "2026-11-03", to: "2026-11-03" });
    expect(periodDates("7d", now)).toEqual({ from: "2026-10-28", to: "2026-11-03" });
    expect(periodDates("month", now)).toEqual({ from: "2026-11-01", to: "2026-11-03" });
    expect(periodDates("last-month", now)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    // Just after midnight in summer time, it's already the next day in London.
    expect(periodDates("today", new Date("2026-06-30T23:30:00Z")).from).toBe("2026-07-01");
  });

  it("shows small amounts a chat with the detail they need", () => {
    expect(usdFine(11_820)).toBe("$0.012");
    expect(usdFine(460)).toBe("$0.0005");
    expect(usdFine(0)).toBe("$0.00");
    expect(usdFine(2_500_000)).toBe("$2.50");
  });
});
