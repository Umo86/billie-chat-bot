/**
 * Deadline chasers, the pure parts: who has done it (by a column of the
 * exhibitor list), which answers look like "done", and filling in one
 * exhibitor's reminder from the email the team approved.
 */

/** In doneValues: any answer at all means done (a date, a reference, a name). */
export const ANY_ANSWER = "*any";

export const PLACEHOLDERS = ["{first_name}", "{company}", "{stand}"] as const;

export const REMIND_DAYS = [0, 3, 7, 14] as const;

const norm = (v: string | undefined) => (v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Has this exhibitor done it, going by their answer in the column? */
export function isDone(
  fields: Record<string, string>,
  column: string,
  doneValues: readonly string[],
): boolean {
  const v = norm(fields[column]);
  if (!v) return false;
  if (doneValues.includes(ANY_ANSWER)) return true;
  return doneValues.map(norm).includes(v);
}

export type ColumnValue = { value: string; count: number };

/** The different answers in each column, most common first (for choosing what means done). */
export function columnValues(
  rows: { fields: Record<string, string> }[],
  columns: readonly string[],
  max = 25,
): Record<string, ColumnValue[]> {
  const out: Record<string, ColumnValue[]> = {};
  for (const c of columns) {
    const counts = new Map<string, { value: string; count: number }>();
    for (const r of rows) {
      const raw = (r.fields[c] ?? "").replace(/\s+/g, " ").trim();
      const key = raw.toLowerCase();
      const hit = counts.get(key);
      if (hit) hit.count++;
      else counts.set(key, { value: raw, count: 1 });
    }
    out[c] = [...counts.values()]
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, max);
  }
  return out;
}

const YES =
  /^(yes|y|done|approved|accepted|submitted|received|complete|completed|ordered|booked|paid|confirmed|true|ok|✓|✔|x)$/i;
const DATE = /^\d{1,4}[/.-]\d{1,2}([/.-]\d{1,4})?$/;

/** A first guess at which answers mean done: yes-like words, or any answer when most look like dates. */
export function guessDone(values: ColumnValue[]): string[] {
  const filled = values.filter((v) => v.value);
  if (!filled.length) return [];
  const dated = filled.filter((v) => DATE.test(v.value)).reduce((n, v) => n + v.count, 0);
  const total = filled.reduce((n, v) => n + v.count, 0);
  if (dated / total > 0.5) return [ANY_ANSWER];
  return filled.filter((v) => YES.test(v.value)).map((v) => v.value.toLowerCase());
}

/** Placeholders in the text Billie doesn't know how to fill in. */
export function unknownPlaceholders(text: string): string[] {
  const found = text.match(/\{[^{}\s]{1,40}\}/g) ?? [];
  return [...new Set(found.filter((p) => !(PLACEHOLDERS as readonly string[]).includes(p)))];
}

/** One exhibitor's copy of the reminder. */
export function fillIn(
  text: string,
  who: { name: string; company: string; stand: string },
): string {
  const first = who.name.trim().split(/\s+/)[0] || "there";
  return text
    .replaceAll("{first_name}", first)
    .replaceAll("{company}", who.company.trim() || "your company")
    .replaceAll("{stand}", who.stand.trim() ? `stand ${who.stand.trim()}` : "your stand");
}

/** The UK date Billie first drafts reminders on ("YYYY-MM-DD"), or null if only by hand. */
export function draftFrom(dueOn: string, remindDaysBefore: number): string | null {
  if (remindDaysBefore <= 0) return null;
  const d = new Date(`${dueOn}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - remindDaysBefore);
  return d.toISOString().slice(0, 10);
}

/** "today", "tomorrow", "in 12 days", "yesterday", "3 days ago" */
export function daysLeft(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1) return `in ${days} days`;
  if (days === -1) return "passed yesterday";
  return `passed ${-days} days ago`;
}

/** Whole days from today to the due date (negative once it has passed), both UK dates. */
export function daysUntil(dueOn: string, today: string): number {
  return Math.round(
    (Date.parse(`${dueOn}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000,
  );
}
