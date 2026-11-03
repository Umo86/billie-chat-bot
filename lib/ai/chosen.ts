import "server-only";
import { getSettings } from "@/lib/settings";
import { fallbackFor, modelFor, type Quality } from "./models";

/** The model (and its backup) for this kind of work, as chosen in Settings → AI. */
export async function modelsFor(
  quality: Quality,
): Promise<{ model: string; fallbackModel: string }> {
  const s = await getSettings();
  const chosen = { fast: s.fastModel, thorough: s.thoroughModel };
  return { model: modelFor(quality, chosen), fallbackModel: fallbackFor(quality, chosen) };
}
