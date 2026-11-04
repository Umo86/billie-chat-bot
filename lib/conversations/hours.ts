import type { BotRules } from "@/lib/types";
import { londonParts } from "@/lib/time";

/**
 * Team hours (pure). Hours are UK time; days 0 = Sunday … 6 = Saturday.
 * During them, a chat that needs a person goes to the team live (Slack, or
 * the Inbox); outside them, Billie takes the person's details. An end of
 * 23:59 means until midnight.
 */
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The end time in minutes: 23:59 is midnight, so "00:00 to 23:59" is the whole day. */
function endMinutes(hhmm: string): number | null {
  const m = toMinutes(hhmm);
  return m === 23 * 60 + 59 ? 24 * 60 : m;
}

export function withinHours(hours: BotRules["hours"], now: Date): boolean {
  const start = toMinutes(hours.start);
  const end = endMinutes(hours.end);
  if (start === null || end === null || end <= start) return false;
  const { day, minutes } = londonParts(now);
  return hours.days.includes(day) && minutes >= start && minutes < end;
}

/** "Mon–Fri, 09:00–17:30" (runs of days joined with a dash). */
export function describeHours(hours: BotRules["hours"]): string {
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => hours.days.includes(d));
  if (!days.length) return "";
  const runs: number[][] = [];
  for (const d of days) {
    const last = runs.at(-1);
    const prev = last?.at(-1);
    const order = (x: number) => (x === 0 ? 7 : x);
    if (last && prev !== undefined && order(d) === order(prev) + 1) last.push(d);
    else runs.push([d]);
  }
  const label = runs
    .map((r) =>
      r.length >= 3
        ? `${DAY_SHORT[r[0]]}–${DAY_SHORT[r.at(-1)!]}`
        : r.map((d) => DAY_SHORT[d]).join(", "),
    )
    .join(", ");
  return `${label}, ${hours.start}–${hours.end}`;
}

export function validTime(hhmm: string): boolean {
  return toMinutes(hhmm) !== null;
}

const STEP_MINUTES = 15;

/**
 * Working minutes between two moments, counted in the bot's team hours (UK
 * time), in 15-minute steps and up to `cap`: enough to tell whether a reply
 * has waited 4 working hours, over nights and weekends.
 */
export function workingMinutes(
  hours: BotRules["hours"],
  from: Date,
  to: Date,
  cap = 24 * 60,
): number {
  const start = toMinutes(hours.start);
  const end = endMinutes(hours.end);
  if (start === null || end === null || end <= start || !hours.days.length) return 0;
  const stepMs = STEP_MINUTES * 60_000;
  const last = Math.min(to.getTime(), from.getTime() + 31 * 86_400_000);
  let counted = 0;
  for (let t = from.getTime(); t + stepMs <= last && counted < cap; t += stepMs) {
    const { day, minutes } = londonParts(new Date(t));
    if (hours.days.includes(day) && minutes >= start && minutes < end) counted += STEP_MINUTES;
  }
  return Math.min(counted, cap);
}
