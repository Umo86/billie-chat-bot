/**
 * Finds the dates in a piece of text, for checking a bot copied for the
 * next show or edition: "Tuesday 24 November", "26 October 2026",
 * "24/11/2026", "March 8th" and a year on its own ("Christmas 2026"). Pure.
 */

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";
const DAYS =
  "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun";

const PATTERNS: RegExp[] = [
  // (Tuesday) 24(th) November (2026)
  new RegExp(
    `\\b(?:(?:${DAYS}),?\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b(?:,?\\s+\\d{4})?`,
    "gi",
  ),
  // (Tuesday) November 24(th)(, 2026)
  new RegExp(
    `\\b(?:(?:${DAYS}),?\\s+)?(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`,
    "gi",
  ),
  // 24/11/2026, 24.11.26, 2026-11-24
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g,
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g,
  // A month and year: November 2026
  new RegExp(`\\b(?:${MONTHS})\\s+(?:19|20)\\d{2}\\b`, "gi"),
  // A year on its own: "Christmas 2026"
  /\b(?:19|20)\d{2}\b/g,
];

export type FoundDate = { text: string; start: number; end: number };

/** Every date in the text, longest match first where they overlap, in order. */
export function findDates(text: string): FoundDate[] {
  const found: FoundDate[] = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // Skip anything inside a longer date already found ("2026" in "26 October 2026").
      if (found.some((f) => start < f.end && end > f.start)) continue;
      found.push({ text: m[0].trim(), start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** A short piece of text around a date, on one line. */
export function dateSnippet(text: string, d: FoundDate, around = 60): string {
  const from = Math.max(0, d.start - around);
  const to = Math.min(text.length, d.end + around);
  const piece = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${piece}${to < text.length ? "…" : ""}`;
}
