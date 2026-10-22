/**
 * Times are stored as timestamptz and shown in UK time (Europe/London).
 * Pure helpers; `now` is always injectable for tests.
 */
export const TIMEZONE = "Europe/London";

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Day of week (0 = Sunday), minutes since midnight and ISO date, in UK time. */
export function londonParts(now: Date): { day: number; minutes: number; date: string } {
  const p = Object.fromEntries(partsFmt.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    day: WEEKDAYS.indexOf(p.weekday ?? ""),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/** "YYYY-MM-DD" in UK time. */
export function londonDate(now: Date = new Date()): string {
  return londonParts(now).date;
}

const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function formatDateTime(d: Date | string): string {
  return dateTimeFmt.format(new Date(d));
}

export function formatDate(d: Date | string): string {
  return dateFmt.format(new Date(d));
}

/** "just now", "5 min ago", "3 h ago", else a date and time. */
export function timeAgo(d: Date | string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(d).getTime();
  if (ms < 45_000) return "just now";
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return formatDateTime(d);
}

/** The moment `days` days before now. */
export function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
