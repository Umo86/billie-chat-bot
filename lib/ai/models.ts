/**
 * Which Claude model does what. Fast (Haiku by default) for visitor answers
 * and email tags; thorough (Sonnet by default) for exhibitor answers and
 * email drafts, where rules, deadlines and money matter. An admin can choose
 * others in Settings → AI; then the environment, then the defaults. Each
 * falls back to the other when the first is overloaded, so an answer still
 * goes out.
 */
type Env = Record<string, string | undefined>;

export type Quality = "fast" | "thorough";

/** What an admin chose in Settings (null: not chosen). */
export type Chosen = { fast?: string | null; thorough?: string | null };

export const DEFAULT_MODELS: Record<Quality, string> = {
  fast: "claude-haiku-5-5",
  thorough: "claude-sonnet-5-5",
};

export function modelFor(quality: Quality, chosen: Chosen = {}, env: Env = process.env): string {
  const picked = quality === "thorough" ? chosen.thorough : chosen.fast;
  const fromEnv = quality === "thorough" ? env.ANTHROPIC_MODEL_SMART : env.ANTHROPIC_MODEL_FAST;
  return picked?.trim() || fromEnv?.trim() || DEFAULT_MODELS[quality];
}

/** The other one; if both are the same model, a different default, so there's always a backup. */
export function fallbackFor(quality: Quality, chosen: Chosen = {}, env: Env = process.env): string {
  const own = modelFor(quality, chosen, env);
  const other = modelFor(quality === "thorough" ? "fast" : "thorough", chosen, env);
  if (other !== own) return other;
  return own === DEFAULT_MODELS.fast ? DEFAULT_MODELS.thorough : DEFAULT_MODELS.fast;
}
