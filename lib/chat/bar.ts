/**
 * The chat bar: an alternative to the round chat button, a bar along the
 * bottom of the website saying "Ask me about" and cycling through topics,
 * with a small animated robot (or the bot's picture). Pure, so the Look
 * step's preview and the server share it; public/widget.js draws the real
 * one on the show's website with the same rules.
 */

export type LauncherStyle = "button" | "bar";
export type BarMascot = "robot" | "picture" | "none";

export const BAR_LEAD_MAX = 30;
export const BAR_TOPIC_MAX = 60;
export const BAR_TOPICS_MAX = 6;
/** Each topic shows for this long before the next slides in. */
export const BAR_TOPIC_MS = 3000;

export const DEFAULT_BAR_LEAD = "Ask me about";

/** Starting topics for each kind of bot. */
export const BAR_TOPIC_EXAMPLES: Record<"exhibitors" | "visitors", string[]> = {
  exhibitors: [
    "build-up and breakdown times",
    "deliveries and parking",
    "badges and stand passes",
    "ordering electrics and furniture",
  ],
  visitors: [
    "opening times and tickets",
    "speakers and talks",
    "getting there and parking",
    "what's on each day",
  ],
};

/** Topics as typed: trimmed, no blanks or repeats, within the limits. */
export function cleanTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of topics) {
    const t = raw.replace(/\s+/g, " ").trim().slice(0, BAR_TOPIC_MAX);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === BAR_TOPICS_MAX) break;
  }
  return out;
}

/** What the bar cycles through: its topics, or "anything" when it has none. */
export function barTopics(topics: string[]): string[] {
  const clean = cleanTopics(topics);
  return clean.length ? clean : ["anything"];
}

/** The bar's words for a screen reader, all at once: "Ask me about A, B or C". */
export function barSpoken(lead: string, topics: string[]): string {
  const t = barTopics(topics);
  const list = t.length === 1 ? t[0] : `${t.slice(0, -1).join(", ")} or ${t.at(-1)}`;
  return `${(lead.trim() || DEFAULT_BAR_LEAD).slice(0, BAR_LEAD_MAX)} ${list}`;
}

/** A colour made lighter (amount > 0) or darker (amount < 0), for the bar's gentle gradient. */
export function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (c: number) => {
    const v = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}
