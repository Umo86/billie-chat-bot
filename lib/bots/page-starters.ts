/**
 * Starter questions for some pages (pure): on the travel page, "Where can I
 * park?"; on the exhibitor manual's deliveries page, "When can we unload?".
 * Each rule is "the page address contains …" with up to three questions;
 * the first rule that matches wins, and pages no rule matches get the bot's
 * usual starters. A rule with no questions shows none on those pages.
 */

export type PageStarters = { match: string; starters: string[] };

export const MAX_PAGE_RULES = 10;
export const MAX_STARTERS = 3;

/** The starters to show on the page at `pageUrl` (null: not on a website, e.g. the chat page). */
export function startersForPage(
  rules: PageStarters[],
  fallback: string[],
  pageUrl: string | null,
): string[] {
  if (!pageUrl) return fallback;
  const url = pageUrl.toLowerCase();
  const rule = rules.find((r) => r.match.trim() && url.includes(r.match.trim().toLowerCase()));
  return rule ? rule.starters : fallback;
}

/** Tidied for saving: trimmed, empty questions and rules without an address left out. */
export function cleanPageRules(rules: PageStarters[]): PageStarters[] {
  return rules
    .map((r) => ({
      match: r.match.trim().slice(0, 200),
      starters: r.starters
        .map((s) => s.trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, MAX_STARTERS),
    }))
    .filter((r) => r.match)
    .slice(0, MAX_PAGE_RULES);
}
