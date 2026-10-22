import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authMode,
  authProblem,
  setupCodeRequired,
  setupCodeValid,
  derivedSecret,
  firstAdminAllowed,
  LINK_GRACE_MS,
  neonAuthBaseUrl,
  neonCookieSecret,
  passwordProblem,
  sessionAllowed,
} from "@/lib/auth/config";
import { classify } from "@/lib/auth/neon-errors";
import { verifySignature, type Jwk } from "@/lib/auth/webhook";

describe("auth mode", () => {
  it("uses Neon Auth whenever its address is set", () => {
    expect(authMode({ NEON_AUTH_BASE_URL: "https://x.neonauth.tech/neondb/auth" })).toBe("neon");
    expect(
      authMode({
        NEON_AUTH_BASE_URL: "https://x.neonauth.tech/neondb/auth",
        BILLIE_LOCAL_AUTH: "1",
      }),
    ).toBe("neon");
  });
  it("allows the local stand-in only off Vercel and only when asked", () => {
    expect(authMode({ BILLIE_LOCAL_AUTH: "1" })).toBe("local");
    expect(authMode({ BILLIE_LOCAL_AUTH: "1", VERCEL: "1" })).toBe("none");
    expect(authMode({})).toBe("none");
  });
  it("accepts only https auth addresses and trims the trailing slash", () => {
    expect(neonAuthBaseUrl({ NEON_AUTH_BASE_URL: "https://a.b/neondb/auth/" })).toBe(
      "https://a.b/neondb/auth",
    );
    expect(neonAuthBaseUrl({ NEON_AUTH_BASE_URL: "http://a.b/auth" })).toBeNull();
    expect(neonAuthBaseUrl({ NEON_AUTH_BASE_URL: "not a url" })).toBeNull();
  });
});

describe("secrets", () => {
  it("derives distinct secrets per purpose from CRON_SECRET", () => {
    const env = { CRON_SECRET: "s3cret-value", VERCEL: "1" };
    const a = derivedSecret("neon-auth-cookie", env);
    const b = derivedSecret("rate-limit", env);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
  it("has no secret on Vercel without CRON_SECRET", () => {
    expect(derivedSecret("x", { VERCEL: "1" })).toBeNull();
    expect(neonCookieSecret({ VERCEL: "1" })).toBeNull();
  });
  it("prefers an explicit cookie secret, but only a long one", () => {
    const long = "x".repeat(40);
    expect(neonCookieSecret({ NEON_AUTH_COOKIE_SECRET: long, VERCEL: "1" })).toBe(long);
    expect(neonCookieSecret({ NEON_AUTH_COOKIE_SECRET: "short", VERCEL: "1" })).toBeNull();
  });
});

describe("first-run set-up code", () => {
  it("is the CRON_SECRET, compared exactly", () => {
    const env = { CRON_SECRET: "the-deployers-secret-value", VERCEL: "1" };
    expect(setupCodeRequired(env)).toBe(true);
    expect(setupCodeValid("the-deployers-secret-value", env)).toBe(true);
    expect(setupCodeValid(" the-deployers-secret-value ", env)).toBe(true);
    expect(setupCodeValid("the-deployers-secret-valu", env)).toBe(false);
    expect(setupCodeValid("", env)).toBe(false);
  });
  it("can't be skipped on Vercel, and isn't asked locally without a secret", () => {
    expect(setupCodeValid("anything", { VERCEL: "1" })).toBe(false);
    expect(setupCodeRequired({})).toBe(false);
    expect(setupCodeValid("", {})).toBe(true);
  });
});

describe("sign-in configuration problems", () => {
  const base = "https://ep-x.neonauth.eu-west-2.aws.neon.tech/neondb/auth";
  it("names what's missing", () => {
    expect(authProblem({ VERCEL: "1" })).toMatch(/NEON_AUTH_BASE_URL/);
    expect(authProblem({ NEON_AUTH_BASE_URL: base })).toMatch(/NEON_AUTH_COOKIE_SECRET/);
    expect(
      authProblem({ NEON_AUTH_BASE_URL: base, NEON_AUTH_COOKIE_SECRET: "x".repeat(32) }),
    ).toBeNull();
    expect(authProblem({ BILLIE_LOCAL_AUTH: "1" })).toBeNull();
  });
  it("never derives the session secret from another secret", () => {
    expect(neonCookieSecret({ CRON_SECRET: "s".repeat(40) })).toBeNull();
  });
});

describe("first admin and passwords", () => {
  it("locks the first account to FIRST_ADMIN_EMAIL when set", () => {
    const env = { FIRST_ADMIN_EMAIL: "Umit@Media10.com", VERCEL: "1" };
    expect(firstAdminAllowed(" umit@media10.com ", env)).toBe(true);
    expect(firstAdminAllowed("someone@else.com", env)).toBe(false);
    expect(firstAdminAllowed("anyone@x.com", { VERCEL: "1" })).toBe(false);
    expect(firstAdminAllowed("anyone@x.com", {})).toBe(true);
  });
  it("asks for a reasonable password", () => {
    expect(passwordProblem("short")).toMatch(/10 characters/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/predictable/);
    expect(passwordProblem("x".repeat(129))).toMatch(/too long/);
    expect(passwordProblem("correct-horse-battery")).toBeNull();
  });
});

describe("sessions and the link to Billie", () => {
  const linked = new Date("2026-10-22T10:00:00Z");
  it("allows sessions that started after the link (within the clock allowance)", () => {
    expect(sessionAllowed(linked, new Date("2026-10-22T10:00:05Z"))).toBe(true);
    expect(sessionAllowed(linked, new Date(linked.getTime() - LINK_GRACE_MS + 1))).toBe(true);
  });
  it("refuses sessions from before the account joined Billie", () => {
    expect(sessionAllowed(linked, new Date("2026-10-22T09:00:00Z"))).toBe(false);
    expect(sessionAllowed(null, new Date())).toBe(false);
    expect(sessionAllowed(linked, null)).toBe(false);
    expect(sessionAllowed(linked, new Date("nonsense"))).toBe(false);
  });
});

describe("Neon Auth errors", () => {
  it("maps upstream errors to plain cases", () => {
    expect(classify({ code: "invalid_credentials", status: 401 }).code).toBe("invalid_credentials");
    expect(classify({ code: "user_already_exists", status: 422 }).code).toBe("user_exists");
    expect(classify({ message: "User already exists. Use another email.", status: 422 }).code).toBe(
      "user_exists",
    );
    expect(classify({ code: "weak_password", status: 400 }).code).toBe("weak_password");
    expect(classify({ code: "NETWORK_DNS", status: 502 }).code).toBe("unavailable");
    expect(
      classify({ message: "Billie is invite-only. Ask an admin to invite you.", status: 400 }).code,
    ).toBe("not_allowed");
    expect(classify({ code: "something_new", status: 500 }).code).toBe("unknown");
  });
  it("never passes upstream wording through", () => {
    expect(
      classify({ code: "x", message: "internal stack trace", status: 500 }).message,
    ).not.toMatch(/stack/);
  });
});

describe("Neon Auth webhook signatures", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" } as Jwk;
  const b64 = (s: string) => Buffer.from(s).toString("base64url");

  function signAsNeon(body: string, ts: number) {
    const header = b64(JSON.stringify({ alg: "EdDSA", kid: "k1", b64: true }));
    const input = `${header}.${b64(`${ts}.${b64(body)}`)}`;
    const sig = sign(null, Buffer.from(input), privateKey).toString("base64url");
    return { signature: `${header}..${sig}`, kid: "k1", timestamp: String(ts) };
  }

  const body = JSON.stringify({ event_type: "user.before_create", user: { email: "a@b.co" } });

  it("accepts a fresh, correctly signed body", () => {
    const now = Date.now();
    expect(verifySignature(body, signAsNeon(body, now), jwk, now)).toBe(true);
  });
  it("rejects a changed body, an old timestamp and a malformed signature", () => {
    const now = Date.now();
    const h = signAsNeon(body, now);
    expect(verifySignature(body.replace("a@b.co", "x@y.co"), h, jwk, now)).toBe(false);
    expect(verifySignature(body, h, jwk, now + 10 * 60_000)).toBe(false);
    expect(
      verifySignature(body, { ...h, signature: h.signature.replace("..", ".x.") }, jwk, now),
    ).toBe(false);
    expect(verifySignature(body, { ...h, signature: null }, jwk, now)).toBe(false);
  });
  it("rejects a key that isn't Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      format: "jwk",
    }) as Jwk;
    const now = Date.now();
    expect(verifySignature(body, signAsNeon(body, now), rsa, now)).toBe(false);
  });
});
