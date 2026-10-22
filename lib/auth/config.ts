/**
 * Sign-in configuration: pure functions of the environment (tested).
 */
import { createHmac } from "node:crypto";

type Env = Record<string, string | undefined>;

export const SESSION_DAYS = 30;
export const COOKIE_PREFIX = "billie";
export const INVITE_DAYS = 7;
export const MIN_PASSWORD = 10;

/**
 * The secret that signs sessions: BETTER_AUTH_SECRET, or (so production has
 * one without anyone typing a new secret) one derived from CRON_SECRET, or a
 * fixed development value outside Vercel. Never sent to the browser.
 */
export function authSecret(env: Env = process.env): string | null {
  const explicit = env.BETTER_AUTH_SECRET?.trim();
  if (explicit) return explicit;
  const cron = env.CRON_SECRET?.trim();
  if (cron) return createHmac("sha256", cron).update("billie:better-auth:v1").digest("hex");
  if (!env.VERCEL) return "billie-local-development-secret-not-for-production";
  return null;
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
  if (password.length > 200) return "That password is too long.";
  if (/^(.)\1+$/.test(password)) return "Use a less predictable password.";
  return null;
}
