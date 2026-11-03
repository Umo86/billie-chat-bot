/**
 * The Claude models Billie can use, and Anthropic's list prices in US
 * dollars per million tokens (Claude credits are US dollars). Checked against
 * platform.claude.com on PRICES_CHECKED; when prices change, change them
 * here. Costs are worked out per call and stored, so the past keeps the
 * price it was charged at.
 */

export const PRICES_CHECKED = "3 November 2026";

type Rates = { input: number; output: number; cacheWrite: number; cacheRead: number };

export type ModelInfo = Rates & {
  id: string;
  name: string;
  /** What it's good for, in a line. */
  blurb: string;
  /** Some models cost more for very long prompts (over this many tokens). */
  longOver?: number;
  long?: Rates;
};

export const MODELS: ModelInfo[] = [
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    blurb: "The fastest and cheapest. Good for visitor questions and sorting emails.",
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheRead: 0.01,
    longOver: 100_000,
    long: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    blurb: "Careful with rules, deadlines and prices. Good for exhibitor answers and email drafts.",
    input: 2,
    output: 10,
    cacheWrite: 2.5,
    cacheRead: 0.1,
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    blurb: "The most capable of the three, and slower. Twice Sonnet's price.",
    input: 4,
    output: 20,
    cacheWrite: 5,
    cacheRead: 0.2,
  },
];

export const MODEL_IDS = MODELS.map((m) => m.id) as [string, ...string[]];

/** The model a reply came from ("claude-sonnet-5-5", or a dated version of it). */
export function modelInfo(id: string): ModelInfo | null {
  const clean = id.trim().toLowerCase();
  return MODELS.find((m) => clean === m.id || clean.startsWith(`${m.id}-`)) ?? null;
}

/** "Claude Sonnet 5.5", or the id itself for a model Billie doesn't know. */
export function modelName(id: string): string {
  if (!id) return "Not recorded";
  if (id === "stand-in") return "Stand-in (tests)";
  return modelInfo(id)?.name ?? id;
}

/** Tokens of one call, split the way they're priced. */
export type Billed = {
  /** Prompt tokens at the full price. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

/**
 * What one call cost, in millionths of a US dollar (tokens times dollars
 * per million tokens), or null for a model with no known price.
 */
export function costMicros(model: string, t: Billed): number | null {
  const m = modelInfo(model);
  if (!m) return null;
  const prompt = t.input + t.cacheWrite + t.cacheRead;
  const r = m.long && m.longOver && prompt > m.longOver ? m.long : m;
  return Math.round(
    t.input * r.input +
      t.cacheWrite * r.cacheWrite +
      t.cacheRead * r.cacheRead +
      t.output * r.output,
  );
}

/** "$12.34", or "$0.0042" for amounts under a cent. */
export function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars > 0 && dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "$2 in, $10 out per million tokens" */
export function priceLine(m: ModelInfo): string {
  const n = (x: number) =>
    `$${x < 1 ? x.toFixed(2) : x.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
  return `${n(m.input)} in, ${n(m.output)} out per million tokens`;
}
