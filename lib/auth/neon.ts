import "server-only";
import { createNeonAuth } from "@neondatabase/auth/next/server";
import { neonAuthBaseUrl, neonCookieSecret } from "./config";
import { classify, type UpstreamError } from "./neon-errors";
import type { AuthProvider, AuthResult, AuthUser } from "./provider";

/**
 * Neon Auth (Neon's managed Better Auth). Users, passwords and sessions live
 * in the neon_auth schema of our own Neon database, run by Neon. Every call
 * here happens on the server: sign-in and sign-up are server actions, and
 * the session cookie it sets is httpOnly.
 */
type NeonAuth = ReturnType<typeof createNeonAuth>;
let instance: NeonAuth | undefined;

/** Made on first use (never at import), so `next build` needs no secrets. */
export function neonAuth(): NeonAuth {
  if (instance) return instance;
  const baseUrl = neonAuthBaseUrl();
  const secret = neonCookieSecret();
  if (!baseUrl) throw new Error("NEON_AUTH_BASE_URL is missing or isn't an https address.");
  if (!secret) throw new Error("NEON_AUTH_COOKIE_SECRET is missing or shorter than 32 characters.");
  instance = createNeonAuth({
    baseUrl,
    cookies: { secret, sameSite: "lax" },
    logLevel: process.env.NODE_ENV === "production" ? "warn" : "info",
  });
  return instance;
}

function toUser(u: { id: string; email: string; name?: string | null } | null | undefined) {
  if (!u?.id) return null;
  return { id: u.id, email: u.email.toLowerCase(), name: u.name ?? "" } satisfies AuthUser;
}

function fail<T>(error: UpstreamError): AuthResult<T> {
  return { ok: false, ...classify(error) };
}

export function neonProvider(): AuthProvider {
  const auth = neonAuth();
  return {
    name: "neon",
    async getSession() {
      const { data } = await auth.getSession();
      const user = toUser(data?.user);
      if (!user || !data?.session) return null;
      const created = data.session.createdAt ? new Date(data.session.createdAt) : null;
      return { user, createdAt: created };
    },
    async signIn(email, password) {
      const { data, error } = await auth.signIn.email({ email, password });
      const user = toUser(data?.user);
      return user ? { ok: true, data: user } : fail(error);
    },
    async signUp({ email, password, name }) {
      const { data, error } = await auth.signUp.email({ email, password, name });
      const user = toUser(data?.user);
      return user ? { ok: true, data: user } : fail(error);
    },
    async signOut() {
      await auth.signOut();
    },
    async requestPasswordReset(email, redirectTo) {
      const { error } = await auth.requestPasswordReset({ email, redirectTo });
      return error ? fail(error) : { ok: true, data: undefined };
    },
    async resetPassword(token, newPassword) {
      const { error } = await auth.resetPassword({ token, newPassword });
      return error ? fail(error) : { ok: true, data: undefined };
    },
  };
}
