import "server-only";
import { authMode } from "./config";

/**
 * The one door to sign-in. Billie talks to Neon Auth through this interface
 * (lib/auth/neon.ts); automated tests use an in-memory stand-in with the
 * same behaviour (lib/auth/local.ts). Nothing else imports either directly.
 */
export type AuthUser = { id: string; email: string; name: string };
export type AuthSession = { user: AuthUser; createdAt: Date | null };

export type AuthFailureCode =
  | "invalid_credentials"
  | "user_exists"
  | "weak_password"
  | "not_allowed"
  | "invalid_token"
  | "unavailable"
  | "not_configured"
  | "unknown";

export type AuthResult<T = undefined> =
  { ok: true; data: T } | { ok: false; code: AuthFailureCode; message: string };

export interface AuthProvider {
  readonly name: "neon" | "local" | "none";
  getSession(): Promise<AuthSession | null>;
  signIn(email: string, password: string): Promise<AuthResult<AuthUser>>;
  signUp(input: { email: string; password: string; name: string }): Promise<AuthResult<AuthUser>>;
  signOut(): Promise<void>;
  /** Emails a link that opens `redirectTo?token=…`. */
  requestPasswordReset(email: string, redirectTo: string): Promise<AuthResult>;
  resetPassword(token: string, newPassword: string): Promise<AuthResult>;
}

const notConfigured: AuthProvider = {
  name: "none",
  async getSession() {
    return null;
  },
  async signIn() {
    return {
      ok: false,
      code: "not_configured",
      message: "Sign-in isn't set up (NEON_AUTH_BASE_URL).",
    };
  },
  async signUp() {
    return {
      ok: false,
      code: "not_configured",
      message: "Sign-in isn't set up (NEON_AUTH_BASE_URL).",
    };
  },
  async signOut() {},
  async requestPasswordReset() {
    return {
      ok: false,
      code: "not_configured",
      message: "Sign-in isn't set up (NEON_AUTH_BASE_URL).",
    };
  },
  async resetPassword() {
    return {
      ok: false,
      code: "not_configured",
      message: "Sign-in isn't set up (NEON_AUTH_BASE_URL).",
    };
  },
};

export async function authProvider(): Promise<AuthProvider> {
  switch (authMode()) {
    case "neon":
      return (await import("./neon")).neonProvider();
    case "local":
      return (await import("./local")).localProvider();
    default:
      return notConfigured;
  }
}
