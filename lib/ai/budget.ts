import "server-only";
import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { aiUsage, users } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";
import { appUrl } from "@/lib/config";
import { adaptiveMessage, plainLine } from "@/lib/alerts/card";
import { cardOf, queueDirect } from "@/lib/alerts/direct";
import { londonDate } from "@/lib/time";
import { usd } from "./pricing";

/**
 * A monthly budget for Claude (Settings → AI), in US dollars as Anthropic
 * bills. Admins get a Teams message at 80% of it and at 100%, once each a
 * month. With the stop switched on, Billie stops using Claude at 100%:
 * chats go to the team and drafts wait, until the month ends or the budget
 * is raised. Answers given again (no tokens) carry on either way.
 */

/** Alerts go at these shares of the budget. */
export const BUDGET_ALERTS = [80, 100] as const;

export type Budget = {
  /** "YYYY-MM" (UK). */
  month: string;
  budgetMicros: number | null;
  spentMicros: number;
  /** Share of the budget used, rounded down (null with no budget). */
  pct: number | null;
  hardStop: boolean;
  /** The budget is used up and the stop is on: no Claude until it's raised or the month ends. */
  stopped: boolean;
};

/** "YYYY-MM-01" for the UK month of `day`. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** What Claude has cost so far this UK month. */
export async function spentThisMonth(now = new Date()): Promise<number> {
  const today = londonDate(now);
  const [row] = await db
    .select({ micros: sql<string>`coalesce(sum(${aiUsage.costMicros}), 0)` })
    .from(aiUsage)
    .where(and(gte(aiUsage.day, monthStart(today)), lte(aiUsage.day, today)));
  return Number(row?.micros ?? 0);
}

export async function budgetNow(now = new Date()): Promise<Budget> {
  const s = await getSettings();
  const budgetMicros = s.monthlyBudgetCents ? s.monthlyBudgetCents * 10_000 : null;
  const spentMicros = await spentThisMonth(now);
  const pct = budgetMicros ? Math.floor((spentMicros / budgetMicros) * 100) : null;
  return {
    month: londonDate(now).slice(0, 7),
    budgetMicros,
    spentMicros,
    pct,
    hardStop: s.budgetHardStop,
    stopped: Boolean(budgetMicros && s.budgetHardStop && spentMicros >= budgetMicros),
  };
}

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });
export const monthName = (month: string) => MONTH.format(new Date(`${month}-15T12:00:00Z`));

export function budgetCard(b: Budget, level: (typeof BUDGET_ALERTS)[number]) {
  const of = `${usd(b.spentMicros)} of the ${usd(b.budgetMicros ?? 0)} budget for ${monthName(b.month)}`;
  const body =
    level === 100
      ? [
          plainLine("Claude's monthly budget is used up", { bold: true, size: "Medium" }),
          plainLine(`Billie has used ${of}.`),
          plainLine(
            b.hardStop
              ? "Billie has stopped using Claude until the month ends or the budget is raised: chats go to the team, and email drafts wait."
              : "Billie keeps answering. To stop at the budget, switch on the stop in Settings → AI.",
          ),
        ]
      : [
          plainLine(`Claude has used ${level}% of this month's budget`, {
            bold: true,
            size: "Medium",
          }),
          plainLine(`Billie has used ${of}.`),
          plainLine(
            b.hardStop
              ? "At 100%, Billie stops using Claude: chats go to the team, and email drafts wait."
              : "Billie keeps answering past the budget unless the stop is on in Settings → AI.",
          ),
        ];
  return adaptiveMessage({
    body,
    actions: [
      { type: "Action.OpenUrl", title: "Open Settings → AI", url: `${appUrl()}/settings?tab=ai` },
    ],
  });
}

/**
 * Every 15 minutes: a Teams message to each admin as the month's spend
 * passes 80% and 100% of the budget (once each a month, per admin).
 */
export async function checkBudget(now = new Date()): Promise<number> {
  const b = await budgetNow(now);
  if (b.pct === null) return 0;
  const passed = BUDGET_ALERTS.filter((level) => (b.pct ?? 0) >= level);
  if (!passed.length) return 0;
  const admins = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, ["admin"]), ne(users.email, "")));
  // Only the highest level passed: past 100% nobody needs the 80% message as well.
  const level = passed[passed.length - 1];
  // The budget is in the key: raising it mid-month sets the messages up again.
  return queueDirect(
    admins,
    `budget:${b.month}:${b.budgetMicros}:${level}`,
    cardOf(budgetCard(b, level)),
  );
}
