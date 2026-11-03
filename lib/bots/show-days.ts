/**
 * A bot's show days (pure): from the first day of build-up to the last day
 * of breakdown, as UK dates ("YYYY-MM-DD"). During them Billie posts a
 * summary in the event's Teams channel each morning (lib/reports/show-day.ts),
 * and the end-of-show report covers them.
 */

/** Build-up to breakdown, however long the show: a month is plenty. */
export const SHOW_DAYS_MAX = 31;

export type ShowDays = { from: string; to: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in "YYYY-MM-DD". */
export function isDay(s: string): boolean {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Days from `from` to `to`, counting both. */
export function daysInclusive(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1
  );
}

/** Why these days don't work, or null if they do. */
export function showDaysProblem(d: ShowDays): { field: "from" | "to"; message: string } | null {
  if (!isDay(d.from)) return { field: "from", message: "Pick the first day." };
  if (!isDay(d.to)) return { field: "to", message: "Pick the last day." };
  if (d.to < d.from) return { field: "to", message: "The last day can't be before the first." };
  if (daysInclusive(d.from, d.to) > SHOW_DAYS_MAX)
    return {
      field: "to",
      message: `Keep it to ${SHOW_DAYS_MAX} days or fewer, from build-up to breakdown.`,
    };
  return null;
}

/**
 * Is there a morning post on `today`? Every show day, and the day after the
 * last one (for breakdown day itself).
 */
export function isPostDay(d: ShowDays | null, today: string): boolean {
  return Boolean(d && d.from <= today && today <= addDays(d.to, 1));
}

const LONG = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** "Tuesday 9 March" (built from parts: some ICU versions add a comma). */
export function dayLabel(day: string): string {
  const p = Object.fromEntries(
    LONG.formatToParts(new Date(`${day}T12:00:00Z`)).map((x) => [x.type, x.value]),
  );
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "8 to 12 March 2027", "30 March to 2 April 2027", "28 December 2026 to 3 January 2027" */
export function rangeLabel(d: ShowDays): string {
  const [fy, fm] = d.from.split("-");
  const [ty, tm] = d.to.split("-");
  const day = (s: string) => Number(s.slice(8, 10));
  const month = (s: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long" }).format(
      new Date(`${s}T12:00:00Z`),
    );
  if (d.from === d.to) return `${day(d.from)} ${month(d.from)} ${fy}`;
  if (fy === ty && fm === tm) return `${day(d.from)} to ${day(d.to)} ${month(d.to)} ${ty}`;
  if (fy === ty) return `${day(d.from)} ${month(d.from)} to ${day(d.to)} ${month(d.to)} ${ty}`;
  return `${day(d.from)} ${month(d.from)} ${fy} to ${day(d.to)} ${month(d.to)} ${ty}`;
}
