import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { settings, usageDaily } from "@/lib/db/schema";
import { londonDate } from "@/lib/time";
import type { Usage } from "./provider";

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

/**
 * True once today's answers reach the cap. Visitors stop at 85% of it, so a
 * flood of public messages can't use up what the team needs for email drafts
 * and test runs.
 */
export async function capReached(
  from: "visitor" | "staff" = "staff",
  now = new Date(),
): Promise<boolean> {
  const [s] = await db.select({ cap: settings.dailyAnswerCap }).from(settings).limit(1);
  const cap = s?.cap ?? 3000;
  if (cap <= 0) return false;
  const limit = from === "visitor" ? Math.floor(cap * VISITOR_SHARE) : cap;
  return (await answersToday(now)) >= limit;
}

export async function recordUsage(scope: string, usage: Usage, now = new Date()): Promise<void> {
  await db
    .insert(usageDaily)
    .values({
      day: londonDate(now),
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
