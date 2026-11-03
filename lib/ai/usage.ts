import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { aiUsage, settings, usageDaily } from "@/lib/db/schema";
import { londonDate } from "@/lib/time";
import { AiError, type Usage } from "./provider";
import { costMicros } from "./pricing";
import { spentThisMonth } from "./budget";

/**
 * Claude use per day (UK date) and the daily safety cap: once the day's
 * answers reach settings.daily_answer_cap, bots hand over instead of
 * calling Claude, so a flood of messages can't run up a bill.
 */
export async function answersToday(now = new Date()): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`coalesce(sum(${usageDaily.requests}), 0)::int` })
    .from(usageDaily)
    .where(eq(usageDaily.day, londonDate(now)));
  return rows[0]?.n ?? 0;
}

/** Share of the daily cap that visitors (chats, WhatsApp) may use; the rest is kept for the team. */
export const VISITOR_SHARE = 0.85;

export type AiLimit = "daily" | "monthly";

/** What to tell people when a limit stops Claude. */
export const LIMIT_LINE: Record<AiLimit, string> = {
  daily: "Today's answer limit has been reached",
  monthly: "This month's Claude budget has been reached",
};

/**
 * Which limit stops Claude now, if any: the day's answers reaching the cap
 * (visitors stop at 85% of it, so a flood of public messages can't use up
 * what the team needs for email drafts and test runs), or the month's
 * budget used up with the stop switched on (lib/ai/budget.ts).
 */
export async function aiLimit(
  from: "visitor" | "staff" = "staff",
  now = new Date(),
): Promise<AiLimit | null> {
  const [s] = await db
    .select({
      cap: settings.dailyAnswerCap,
      budgetCents: settings.monthlyBudgetCents,
      stop: settings.budgetHardStop,
    })
    .from(settings)
    .limit(1);
  const cap = s?.cap ?? 3000;
  if (cap > 0) {
    const limit = from === "visitor" ? Math.floor(cap * VISITOR_SHARE) : cap;
    if ((await answersToday(now)) >= limit) return "daily";
  }
  if (s?.stop && s.budgetCents && (await spentThisMonth(now)) >= s.budgetCents * 10_000)
    return "monthly";
  return null;
}

export async function capReached(
  from: "visitor" | "staff" = "staff",
  now = new Date(),
): Promise<boolean> {
  return (await aiLimit(from, now)) !== null;
}

/** The error to throw when a limit stops Claude. */
export function limitError(limit: AiLimit): AiError {
  return new AiError("cap_reached", LIMIT_LINE[limit]);
}

/**
 * Counts one Claude call: in usage_daily (requests and tokens, for the daily
 * cap) and in ai_usage, by model and with what it cost (Settings → AI).
 */
export async function recordUsage(
  scope: string,
  usage: Usage,
  model: string,
  now = new Date(),
): Promise<void> {
  const day = londonDate(now);
  const billed = {
    input: Math.max(0, usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens),
    cacheWrite: usage.cacheWriteTokens,
    cacheRead: usage.cachedTokens,
    output: usage.outputTokens,
  };
  const cost = costMicros(model, billed) ?? 0;
  await db
    .insert(aiUsage)
    .values({
      day,
      scope,
      model,
      requests: 1,
      inputTokens: billed.input,
      cacheWriteTokens: billed.cacheWrite,
      cacheReadTokens: billed.cacheRead,
      outputTokens: billed.output,
      costMicros: cost,
    })
    .onConflictDoUpdate({
      target: [aiUsage.day, aiUsage.scope, aiUsage.model],
      set: {
        requests: sql`${aiUsage.requests} + 1`,
        inputTokens: sql`${aiUsage.inputTokens} + ${billed.input}`,
        cacheWriteTokens: sql`${aiUsage.cacheWriteTokens} + ${billed.cacheWrite}`,
        cacheReadTokens: sql`${aiUsage.cacheReadTokens} + ${billed.cacheRead}`,
        outputTokens: sql`${aiUsage.outputTokens} + ${billed.output}`,
        costMicros: sql`${aiUsage.costMicros} + ${cost}`,
      },
    });
  await db
    .insert(usageDaily)
    .values({
      day,
      scope,
      requests: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
    })
    .onConflictDoUpdate({
      target: [usageDaily.day, usageDaily.scope],
      set: {
        requests: sql`${usageDaily.requests} + 1`,
        inputTokens: sql`${usageDaily.inputTokens} + ${usage.inputTokens}`,
        outputTokens: sql`${usageDaily.outputTokens} + ${usage.outputTokens}`,
        cachedTokens: sql`${usageDaily.cachedTokens} + ${usage.cachedTokens}`,
      },
    });
}
