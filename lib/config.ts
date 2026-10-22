/**
 * Configuration read from the environment. No secrets are returned from
 * here; modules that need a key read it themselves, server-side only.
 */
type Env = Record<string, string | undefined>;

/** Product name in the app and emails (config, never hard-coded). */
export const brandName = process.env.NEXT_PUBLIC_BRAND_NAME ?? "Billie";

/** The app's public address, for embed code, links and QR codes. */
export function appUrl(env: Env = process.env): string {
  const explicit = env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_BRANCH_URL ?? env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  return `http://localhost:${env.PORT ?? "3000"}`;
}

export type AiProviderName = "anthropic" | "fake" | "none";

/**
 * Claude via the Anthropic API when ANTHROPIC_API_KEY is set. AI_PROVIDER=fake
 * (tests, demos) uses a deterministic stand-in that never calls out; it is
 * refused on Vercel production so a live bot can never answer from it.
 */
export function aiProvider(env: Env = process.env): AiProviderName {
  if (env.AI_PROVIDER === "fake" && env.VERCEL_ENV !== "production") return "fake";
  if (env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  return "none";
}

export type EmbeddingsProviderName = "voyage" | "fake" | "none";

/** Meaning search via Voyage AI when VOYAGE_API_KEY is set; keyword search works without it. */
export function embeddingsProvider(env: Env = process.env): EmbeddingsProviderName {
  if (env.EMBEDDINGS_PROVIDER === "fake" && env.VERCEL_ENV !== "production") return "fake";
  if (env.VOYAGE_API_KEY?.trim()) return "voyage";
  return "none";
}

export function emailConfigured(env: Env = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim() && env.EMAIL_FROM?.trim());
}

export function outlookConfigured(env: Env = process.env): boolean {
  return Boolean(
    env.MS_TENANT_ID?.trim() &&
    env.MS_CLIENT_ID?.trim() &&
    env.MS_CLIENT_SECRET?.trim() &&
    env.MS_MAILBOX?.trim(),
  );
}

export function whatsappConfigured(env: Env = process.env): boolean {
  return Boolean(
    env.WHATSAPP_TOKEN?.trim() &&
    env.WHATSAPP_PHONE_NUMBER_ID?.trim() &&
    env.WHATSAPP_APP_SECRET?.trim() &&
    env.WHATSAPP_VERIFY_TOKEN?.trim(),
  );
}

export function teamsConfigured(env: Env = process.env): boolean {
  return Boolean(env.TEAMS_WEBHOOK_URL?.trim());
}

export function blobConfigured(env: Env = process.env): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN?.trim());
}
