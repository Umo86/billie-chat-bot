/**
 * Sign-in configuration: pure functions of the environment (tested in
 * tests/unit/auth-config.test.ts).
 *
 * Who someone is (email and password) is Neon Auth's job: Neon's managed
 * Better Auth, with its users in the neon_auth schema of our database. What
 * they may do in Billie (role, suspended or not) is ours, in the users table.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export const INVITE_DAYS = 7;
export const MIN_PASSWORD = 10;

/**
 * Sessions that started more than this long before an account joined
 * Billie are refused, so a session someone made before the invitation was
 * accepted can never become a way in (clock skew allowance included).
 */
export const LINK_GRACE_MS = 60_000;

export type AuthMode = "neon" | "local" | "none";

/**
 * "neon" whenever NEON_AUTH_BASE_URL is set (always, on a deployment).
 * "local" is an in-memory stand-in for automated tests and offline work
 * (BILLIE_LOCAL_AUTH=1), refused on Vercel so it can never run in
 * production. Otherwise sign-in isn't set up.
 */
export function authMode(env: Env = process.env): AuthMode {
  if (env.NEON_AUTH_BASE_URL?.trim()) return "neon";
  if (env.BILLIE_LOCAL_AUTH === "1" && !env.VERCEL) return "local";
  return "none";
}

export function neonAuthBaseUrl(env: Env = process.env): string | null {
  const raw = env.NEON_AUTH_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * A key for one low-stakes purpose (hashing rate-limit buckets, marking
 * checked chat-frame requests), derived from CRON_SECRET. A fixed value is
 * used only off Vercel. Never used for sessions: see neonCookieSecret.
 */
export function derivedSecret(purpose: string, env: Env = process.env): string | null {
  const cron = env.CRON_SECRET?.trim();
  if (cron) return createHmac("sha256", cron).update(`billie:${purpose}:v1`).digest("hex");
  if (!env.VERCEL) return `billie-local-${purpose}-secret-not-for-production`;
  return null;
}

/**
 * Signs Neon Auth's session cache cookie. Its own secret, never derived from
 * another: whoever holds it could sign in as anyone.
 */
export function neonCookieSecret(env: Env = process.env): string | null {
  const explicit = env.NEON_AUTH_COOKIE_SECRET?.trim();
  return explicit && explicit.length >= 32 ? explicit : null;
}

/** What's missing for sign-in to work, in words for the sign-in page; null when ready. */
export function authProblem(env: Env = process.env): string | null {
  const mode = authMode(env);
  if (mode === "local") return null;
  if (mode === "none")
    return "Sign-in isn't set up yet: add NEON_AUTH_BASE_URL in Vercel, then redeploy.";
  if (!neonAuthBaseUrl(env)) return "NEON_AUTH_BASE_URL must be the https Auth URL from Neon.";
  if (!neonCookieSecret(env))
    return "Add NEON_AUTH_COOKIE_SECRET in Vercel (32 or more random characters), then redeploy.";
  return null;
}

/**
 * First-run set-up asks for a code only the person who deployed Billie
 * knows (the CRON_SECRET they set), so nobody else can claim the first
 * admin account on a fresh site. Locally, without CRON_SECRET, it isn't asked.
 */
export function setupCodeRequired(env: Env = process.env): boolean {
  return Boolean(env.CRON_SECRET?.trim()) || Boolean(env.VERCEL);
}

export function setupCodeValid(code: string, env: Env = process.env): boolean {
  if (!setupCodeRequired(env)) return true;
  const expected = env.CRON_SECRET?.trim();
  if (!expected) return false;
  const a = createHash("sha256").update(code.trim()).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Who may create the first admin account. On a deployment, only
 * FIRST_ADMIN_EMAIL (so nobody who finds the address first can claim it);
 * locally, anyone.
 */
export function firstAdminAllowed(email: string, env: Env = process.env): boolean {
  const required = env.FIRST_ADMIN_EMAIL?.trim().toLowerCase();
  if (required) return email.trim().toLowerCase() === required;
  return !env.VERCEL;
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 128) return "That password is too long.";
  if (/^(.)\1+$/.test(password)) return "Use a less predictable password.";
  return null;
}

/** True when a session may act for an account linked at `linkedAt`. */
export function sessionAllowed(linkedAt: Date | null, sessionCreatedAt: Date | null): boolean {
  if (!linkedAt) return false;
  if (!sessionCreatedAt || Number.isNaN(sessionCreatedAt.getTime())) return false;
  return sessionCreatedAt.getTime() >= linkedAt.getTime() - LINK_GRACE_MS;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
