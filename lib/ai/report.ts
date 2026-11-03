import "server-only";
import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { aiUsage, bots } from "@/lib/db/schema";
import { londonDate } from "@/lib/time";

/**
 * Settings → AI: Claude use and its cost over a period of UK dates, by model,
 * by what it was for, and by day. Costs are in millionths of a US dollar,
 * worked out per call when it was made (lib/ai/usage.ts).
 */

export type Period = "today" | "7d" | "month" | "last-month";

export const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "month", label: "This month" },
  { key: "last-month", label: "Last month" },
];

const shift = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The first and last UK date of the period. */
export function periodDates(p: Period, now = new Date()): { from: string; to: string } {
  const today = londonDate(now);
  if (p === "today") return { from: today, to: today };
  if (p === "7d") return { from: shift(today, -6), to: today };
  const first = `${today.slice(0, 8)}01`;
  if (p === "month") return { from: first, to: today };
  const lastDay = shift(first, -1);
  return { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
}

export type Totals = {
  requests: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
};

const sums = {
  requests: sql<number>`coalesce(sum(${aiUsage.requests}), 0)::int`,
  input: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::float8`,
  cacheWrite: sql<number>`coalesce(sum(${aiUsage.cacheWriteTokens}), 0)::float8`,
  cacheRead: sql<number>`coalesce(sum(${aiUsage.cacheReadTokens}), 0)::float8`,
  output: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::float8`,
  cost: sql<number>`coalesce(sum(${aiUsage.costMicros}), 0)::float8`,
};

const LABELS: Record<string, string> = {
  email: "Emails: sorting and drafting replies",
  suggestion: "Suggested replies in the Inbox",
  learning: "Learning from sent emails",
  check: "Knowledge checks",
  reminders: "Deadline reminders",
};

/** What a scope was for, in words. */
export function scopeLabel(scope: string, botNames: Map<string, string>): string {
  if (scope.startsWith("bot:")) {
    const name = botNames.get(scope.slice(4));
    return `Answers: ${name ?? "a deleted bot"}`;
  }
  return LABELS[scope] ?? scope;
}

export async function aiUsageReport(period: Period, now = new Date()) {
  const { from, to } = periodDates(period, now);
  const inPeriod = and(gte(aiUsage.day, from), lte(aiUsage.day, to));
  // Answers given again didn't ask Claude: counted on their own, not as requests.
  const claude = and(inPeriod, ne(aiUsage.model, "reused"));
  const [[totals], byModel, byScope, byDay, names, [reused]] = await Promise.all([
    db.select(sums).from(aiUsage).where(claude),
    db
      .select({ model: aiUsage.model, ...sums })
      .from(aiUsage)
      .where(inPeriod)
      .groupBy(aiUsage.model)
      .orderBy(sql`sum(${aiUsage.costMicros}) DESC`, sql`sum(${aiUsage.requests}) DESC`),
    db
      .select({
        scope: aiUsage.scope,
        ...sums,
        unpriced: sql<number>`coalesce(sum(${aiUsage.requests}) FILTER (WHERE ${aiUsage.model} = ''), 0)::int`,
      })
      .from(aiUsage)
      .where(claude)
      .groupBy(aiUsage.scope)
      .orderBy(sql`sum(${aiUsage.costMicros}) DESC`, sql`sum(${aiUsage.requests}) DESC`),
    db
      .select({ day: aiUsage.day, ...sums })
      .from(aiUsage)
      .where(claude)
      .groupBy(aiUsage.day)
      .orderBy(aiUsage.day),
    db.select({ id: bots.id, name: bots.name }).from(bots),
    db
      .select({
        count: sql<number>`coalesce(sum(${aiUsage.requests}), 0)::int`,
        saved: sql<number>`coalesce(sum(${aiUsage.savedMicros}), 0)::float8`,
      })
      .from(aiUsage)
      .where(and(inPeriod, eq(aiUsage.model, "reused"))),
  ]);
  const botNames = new Map(names.map((b) => [b.id, b.name]));
  // Every day of the period, with nothing on the quiet ones.
  const days: (Totals & { day: string })[] = [];
  for (let d = from; d <= to; d = shift(d, 1)) {
    const hit = byDay.find((x) => x.day === d);
    days.push(
      hit ?? { day: d, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 },
    );
  }
  return {
    from,
    to,
    totals: totals as Totals,
    byModel,
    byScope: byScope.map((s) => ({ ...s, label: scopeLabel(s.scope, botNames) })),
    days,
    /** Answers given again without Claude, and what they'd have cost. */
    reused: { count: reused?.count ?? 0, saved: reused?.saved ?? 0 },
    /** Requests from before models were recorded: tokens known, cost not. */
    unpriced: byModel.find((m) => m.model === "")?.requests ?? 0,
  };
}
