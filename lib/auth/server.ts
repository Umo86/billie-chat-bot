import "server-only";
import { and, eq } from "drizzle-orm";
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db/client";
import { authAccount, authSession, authVerification, users } from "@/lib/db/schema";
import { appUrl } from "@/lib/config";
import { COOKIE_PREFIX, SESSION_DAYS, authSecret } from "./config";

/**
 * Better Auth, self-hosted with sessions in our own database (as in Hall
 * Pass). There is no public sign-up and no HTTP auth API: sign-in, set-up and
 * invitations are server actions that call auth.api on the server, so no
 * unused endpoint can be reached. Suspended people can't start a session.
 */
function createAuth() {
  const base = appUrl();
  return betterAuth({
    appName: "Billie",
    baseURL: base,
    secret: authSecret() ?? undefined,
    trustedOrigins: [new URL(base).origin],
    database: drizzleAdapter(db, {
      provider: "pg",
      transaction: true,
      schema: { users, authSession, authAccount, authVerification },
    }),
    user: {
      modelName: "users",
      fields: { name: "fullName" },
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    session: {
      modelName: "authSession",
      expiresIn: SESSION_DAYS * 86_400,
      updateAge: 86_400,
      cookieCache: { enabled: false },
    },
    account: { modelName: "authAccount", accountLinking: { enabled: false } },
    verification: { modelName: "authVerification" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 10,
      maxPasswordLength: 200,
    },
    // Our sign-in action has its own database-backed limits (lib/rate-limit.ts).
    rateLimit: { enabled: false },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: base.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] },
      database: { generateId: "uuid" },
    },
    telemetry: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const active = await db.query.users.findFirst({
              where: and(eq(users.id, session.userId), eq(users.status, "active")),
              columns: { id: true },
            });
            return active ? undefined : false;
          },
        },
      },
    },
    // Must stay last: lets server actions set the session cookie.
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** Made on first use, never at import, so `next build` doesn't need a database or secret. */
export function getAuth(): Auth {
  return (instance ??= createAuth());
}
