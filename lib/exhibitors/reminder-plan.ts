/**
 * How often a bot's deadline reminders go out (pure; Exhibitors step →
 * "How often Billie reminds"). Each deadline says when the first round
 * starts (7 days before, say). The plan says what happens after that: one
 * round, or another every few days until the exhibitor has done it or the
 * deadline passes; whether those repeats wait for a person to check them;
 * the fewest days between two reminder emails to the same exhibitor; and
 * weekdays only.
 *
 * A repeat reuses the wording a person approved and sent for that deadline
 * (no Claude call, so it costs nothing). Without one, the round is a new
 * draft for a person to check, however the plan is set.
 */
import { daysUntil, draftFrom } from "./deadline-rules";

export const REPEAT_DAYS = [0, 3, 7] as const;
export const GAP_DAYS = [1, 2, 3, 7] as const;

export type ReminderPlan = {
  /** 0: one round per deadline; 3 or 7: again every so many days until it's done or due. */
  repeatDays: (typeof REPEAT_DAYS)[number];
  /** Repeats are sent without a check, in the approved wording. */
  autoSend: boolean;
  /** The fewest days between two reminder emails to the same exhibitor (when repeating). */
  gapDays: (typeof GAP_DAYS)[number];
  /** No rounds start on Saturdays or Sundays (UK). */
  weekdaysOnly: boolean;
};

export const DEFAULT_PLAN: ReminderPlan = {
  repeatDays: 0,
  autoSend: false,
  gapDays: 2,
  weekdaysOnly: true,
};

/** A saved plan, read safely: anything unexpected falls back to the default. */
export function planOf(row: Partial<Record<keyof ReminderPlan, unknown>> | null | undefined) {
  const pick = <T>(allowed: readonly T[], v: unknown, d: T): T =>
    allowed.includes(v as T) ? (v as T) : d;
  return {
    repeatDays: pick(REPEAT_DAYS, row?.repeatDays, DEFAULT_PLAN.repeatDays),
    autoSend: typeof row?.autoSend === "boolean" ? row.autoSend : DEFAULT_PLAN.autoSend,
    gapDays: pick(GAP_DAYS, row?.gapDays, DEFAULT_PLAN.gapDays),
    weekdaysOnly:
      typeof row?.weekdaysOnly === "boolean" ? row.weekdaysOnly : DEFAULT_PLAN.weekdaysOnly,
  } satisfies ReminderPlan;
}

/** Saturday or Sunday, for a UK date ("YYYY-MM-DD"). */
export function isWeekend(day: string): boolean {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

export type RoundState = {
  status: "drafting" | "ready" | "sending" | "sent" | "discarded" | "failed";
  /** UK dates. */
  createdOn: string;
  sentOn: string | null;
};

const OPEN: RoundState["status"][] = ["drafting", "ready", "sending"];

/**
 * What the daily schedule does today for one deadline: start its first round
 * (a draft for a person to check), repeat the approved one, or nothing.
 */
export function nextRound(input: {
  today: string;
  dueOn: string;
  remindDaysBefore: number;
  plan: ReminderPlan;
  /** The deadline's newest round, if any. */
  latest: RoundState | null;
  /** Whether a round of it has been approved and sent, so its wording can be used again. */
  hasSent: boolean;
}): "first" | "repeat" | null {
  const { today, plan, latest } = input;
  const from = draftFrom(input.dueOn, input.remindDaysBefore);
  // Only when asked, not started yet, or passed.
  if (!from || today < from || today > input.dueOn) return null;
  if (plan.weekdaysOnly && isWeekend(today)) return null;
  // One round at a time: the open one is still being written, checked or sent.
  if (latest && OPEN.includes(latest.status)) return null;
  // Nothing since the first reminder day (one by hand before it doesn't count).
  if (!latest || latest.createdOn < from) return "first";
  if (!plan.repeatDays) return null;
  const last = latest.sentOn ?? latest.createdOn;
  if (daysUntil(today, last) < plan.repeatDays) return null;
  return input.hasSent ? "repeat" : "first";
}

/** A repeat's subject: the approved one, marked as a reminder once. */
export function repeatSubject(subject: string): string {
  const s = subject.trim();
  return /^(reminder|a reminder|friendly reminder)\b/i.test(s) ? s : `Reminder: ${s}`.slice(0, 200);
}

/** Whether a reminder email to them on `sentOn` is too recent for another today. */
export function tooSoon(sentOn: string, today: string, gapDays: number): boolean {
  return daysUntil(today, sentOn) < gapDays;
}

/** The plan in a sentence, for the Exhibitors step. */
export function planSummary(plan: ReminderPlan): string {
  if (!plan.repeatDays)
    return `Billie drafts one round of reminders for each deadline, for you to check${plan.weekdaysOnly ? ", on a weekday" : ""}.`;
  const every = plan.repeatDays === 7 ? "every week" : `every ${plan.repeatDays} days`;
  return [
    `Billie drafts the first round for you to check, then reminds again ${every} until they've done it or the deadline passes.`,
    plan.autoSend
      ? "Repeats go automatically, in the wording you approved."
      : "You check each repeat before it goes.",
    `Nobody gets more than one reminder email in ${plan.gapDays === 1 ? "a day" : `${plan.gapDays} days`}${plan.weekdaysOnly ? ", and only on weekdays" : ""}.`,
  ].join(" ");
}
