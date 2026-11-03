/**
 * Who handles what (pure): a bot's People step can say "Electrics: electric,
 * power, socket → Sam". A chat passed to the team, or an email that needs a
 * person, whose words match goes to that person first. Words match at the
 * start of a word ("electric" finds "electrics" and "electricity"); the rule
 * with the most different words found wins, the first on a tie.
 */

export type HandoverRoute = { id: string; topic: string; words: string[]; userId: string };

export const MAX_ROUTES = 15;
export const MAX_WORDS = 20;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The rule for these words, if one matches. */
export function matchRoute(routes: HandoverRoute[], texts: string[]): HandoverRoute | null {
  const text = texts.join("\n").toLowerCase();
  let best: { route: HandoverRoute; score: number } | null = null;
  for (const route of routes) {
    const score = route.words.filter((w) => {
      const word = w.trim().toLowerCase();
      return word && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}`, "u").test(text);
    }).length;
    if (score && (!best || score > best.score)) best = { route, score };
  }
  return best?.route ?? null;
}

/** "electric, power; sockets" → ["electric", "power", "sockets"] */
export function wordList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,;\n]+/)
        .map((w) => w.trim().toLowerCase().slice(0, 60))
        .filter(Boolean),
    ),
  ].slice(0, MAX_WORDS);
}
