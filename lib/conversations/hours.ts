import type { BotRules } from "@/lib/types";
import { londonParts } from "@/lib/time";

/**
 * Team hours (pure). Hours are UK time; days 0 = Sunday … 6 = Saturday.
 * Billie hands over live only when someone is marked available in the Inbox;
 * hours are what it tells people when nobody is.
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

export function withinHours(hours: BotRules["hours"], now: Date): boolean {
  const start = toMinutes(hours.start);
  const end = toMinutes(hours.end);
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
