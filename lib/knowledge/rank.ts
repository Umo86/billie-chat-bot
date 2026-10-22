/**
 * Combining search results (pure). Keyword search (Postgres full-text) and
 * meaning search (pgvector) each return passages in order; Reciprocal Rank
 * Fusion merges them without having to compare their incomparable scores.
 * Typed answers get a small boost: when they disagree with a file, they win.
 */
export type Ranked = { id: string; boost?: number };

export const RRF_K = 60;

export function fuseRankings(lists: Ranked[][], k = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  const boosts = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1));
      if (item.boost) boosts.set(item.id, Math.max(boosts.get(item.id) ?? 0, item.boost));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score: score * (1 + (boosts.get(id) ?? 0)) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Common words that carry no meaning for search. */
const STOP = new Set(
  (
    "a an the and or of to in on for at by with from into about is are was were be been being am it its this that " +
    "these those as do does did done can could should would will shall may might must i me my you your yours we our " +
    "ours they them their he she his her what when where which who whom whose how why if then than so not no yes please " +
    "hi hello hey thanks thank there here any some all also just get got have has had need want know tell let make one"
  ).split(" "),
);

/** Everyday synonyms people use for show logistics (keyword search only; meaning search needs none). */
const SYNONYMS: Record<string, string[]> = {
  wifi: ["internet", "wireless"],
  internet: ["wifi"],
  badge: ["pass", "lanyard", "registration"],
  pass: ["badge"],
  parking: ["park", "car"],
  park: ["parking"],
  vehicle: ["van", "lorry", "truck"],
  delivery: ["deliver", "courier", "freight", "logistics"],
  deliver: ["delivery", "courier"],
  courier: ["delivery"],
  build: ["buildup", "setup", "construction"],
  buildup: ["build"],
  setup: ["build", "buildup"],
  breakdown: ["dismantle", "teardown"],
  open: ["opening", "hours", "times"],
  hours: ["opening", "times"],
  cost: ["price", "fee", "charge"],
  price: ["cost", "fee"],
  food: ["catering", "restaurant", "cafe"],
  venue: ["address", "location"],
  where: ["venue", "address", "location"],
  when: ["date", "dates", "time"],
  ticket: ["register", "registration"],
  register: ["registration", "ticket"],
  furniture: ["chair", "table", "stool"],
  electric: ["electrics", "power", "electricity"],
  power: ["electric", "electricity"],
  child: ["children", "kids"],
  kids: ["children", "child"],
};

/** "deliveries" → "delivery", "badges" → "badge"; other words unchanged. */
function singular(w: string): string {
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

/**
 * Words of a question worth searching for, with everyday synonyms.
 * Lowercase, de-duplicated. Question words ("where", "when") are dropped
 * themselves but still bring their synonyms ("venue", "date").
 */
export function searchTerms(question: string, max = 24): string[] {
  const words = (
    question
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[a-z0-9]+/g) ?? []
  ).filter((w) => w.length > 1);
  const out = new Set<string>();
  for (const w of words) {
    const one = singular(w);
    if (!STOP.has(w)) {
      out.add(w);
      out.add(one);
    }
    for (const s of SYNONYMS[w] ?? SYNONYMS[one] ?? []) out.add(s);
  }
  return [...out].slice(0, max);
}
