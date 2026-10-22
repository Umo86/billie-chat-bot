import "server-only";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { authMode, MIN_PASSWORD } from "./config";
import type { AuthProvider, AuthResult, AuthUser } from "./provider";

/**
 * In-memory stand-in for Neon Auth, for automated tests and offline work
 * only (BILLIE_LOCAL_AUTH=1, never on Vercel: see authMode). It behaves like
 * Neon Auth where Billie can tell: same error cases, a session cookie, and
 * sessions with a start time. Everything is forgotten when the server stops.
 */
type Account = AuthUser & { hash: string; salt: string };
type Session = { userId: string; createdAt: Date; expiresAt: Date };
type Store = {
  accounts: Map<string, Account>; // by email
  sessions: Map<string, Session>; // by token
  resets: Map<string, { email: string; expiresAt: number }>;
  outbox: { email: string; link: string }[];
};

const COOKIE = "billie_local_session";
const SESSION_MS = 7 * 86_400_000;

function store(): Store {
  const g = globalThis as typeof globalThis & { __billieLocalAuth?: Store };
  return (g.__billieLocalAuth ??= {
    accounts: new Map(),
    sessions: new Map(),
    resets: new Map(),
    outbox: [],
  });
}

function hash(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

function matches(account: Account, password: string): boolean {
  const a = Buffer.from(hash(password, account.salt), "hex");
  const b = Buffer.from(account.hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function startSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  store().sessions.set(token, { userId, createdAt: now, expiresAt: new Date(+now + SESSION_MS) });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // tests run over plain http://localhost
    path: "/",
    maxAge: SESSION_MS / 1000,
  });
}

function publicUser(a: Account): AuthUser {
  return { id: a.id, email: a.email, name: a.name };
}

/** Test helper: the reset links "sent" so far. */
export function localOutbox(): { email: string; link: string }[] {
  return store().outbox;
}

export function localProvider(): AuthProvider {
  if (authMode() !== "local") throw new Error("Local sign-in is for tests and offline work only.");
  return {
    name: "local",
    async getSession() {
      const token = (await cookies()).get(COOKIE)?.value;
      if (!token) return null;
      const s = store().sessions.get(token);
      if (!s || s.expiresAt < new Date()) return null;
      const account = [...store().accounts.values()].find((a) => a.id === s.userId);
      return account ? { user: publicUser(account), createdAt: s.createdAt } : null;
    },
    async signIn(email, password): Promise<AuthResult<AuthUser>> {
      const account = store().accounts.get(email.trim().toLowerCase());
      if (!account || !matches(account, password))
        return {
          ok: false,
          code: "invalid_credentials",
          message: "That email and password don't match.",
        };
      await startSession(account.id);
      return { ok: true, data: publicUser(account) };
    },
    async signUp({ email, password, name }): Promise<AuthResult<AuthUser>> {
      const key = email.trim().toLowerCase();
      if (store().accounts.has(key))
        return {
          ok: false,
          code: "user_exists",
          message: "There is already a sign-in for this email.",
        };
      if (password.length < MIN_PASSWORD)
        return { ok: false, code: "weak_password", message: "Choose a longer password." };
      const salt = randomBytes(16).toString("hex");
      const account: Account = {
        id: randomUUID(),
        email: key,
        name,
        salt,
        hash: hash(password, salt),
      };
      store().accounts.set(key, account);
      await startSession(account.id);
      return { ok: true, data: publicUser(account) };
    },
    async signOut() {
      const jar = await cookies();
      const token = jar.get(COOKIE)?.value;
      if (token) store().sessions.delete(token);
      jar.delete(COOKIE);
    },
    async requestPasswordReset(email, redirectTo) {
      const key = email.trim().toLowerCase();
      // Like Neon Auth: the same answer whether or not the account exists.
      if (store().accounts.has(key)) {
        const token = randomBytes(24).toString("base64url");
        store().resets.set(token, { email: key, expiresAt: Date.now() + 15 * 60_000 });
        const url = new URL(redirectTo);
        url.searchParams.set("token", token);
        store().outbox.push({ email: key, link: url.toString() });
      }
      return { ok: true, data: undefined };
    },
    async resetPassword(token, newPassword) {
      const r = store().resets.get(token);
      store().resets.delete(token);
      const account = r && r.expiresAt > Date.now() ? store().accounts.get(r.email) : undefined;
      if (!account)
        return {
          ok: false,
          code: "invalid_token",
          message: "This link has expired. Ask for a new one.",
        };
      if (newPassword.length < MIN_PASSWORD)
        return { ok: false, code: "weak_password", message: "Choose a longer password." };
      account.salt = randomBytes(16).toString("hex");
      account.hash = hash(newPassword, account.salt);
      // A new password ends this account's sessions.
      for (const [t, s] of store().sessions)
        if (s.userId === account.id) store().sessions.delete(t);
      return { ok: true, data: undefined };
    },
  };
}
