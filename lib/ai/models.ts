/**
 * Which Claude model does what. Fast (Haiku) for visitor answers and email
 * tags; thorough (Sonnet) for exhibitor answers and email drafts, where
 * rules, deadlines and money matter. Each falls back to the other when the
 * first is overloaded, so an answer still goes out.
 */
type Env = Record<string, string | undefined>;

export type Quality = "fast" | "thorough";

export function modelFor(quality: Quality, env: Env = process.env): string {
  return quality === "thorough"
    ? env.ANTHROPIC_MODEL_SMART?.trim() || "claude-sonnet-5-5"
    : env.ANTHROPIC_MODEL_FAST?.trim() || "claude-haiku-5-5";
}

export function fallbackFor(quality: Quality, env: Env = process.env): string {
  return modelFor(quality === "thorough" ? "fast" : "thorough", env);
}
