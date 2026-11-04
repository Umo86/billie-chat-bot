import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  emailsIn,
  MAX_EXHIBITORS,
  MAX_FIELDS,
  MAX_HEADING,
  MAX_VALUE,
  type ListedExhibitor,
} from "./list";

/**
 * BluePrint, the exhibitor manual, working with Billie (pure; the database
 * side is lib/exhibitors/blueprint.ts, the guide for BluePrint is
 * docs/blueprint.md).
 *
 * One key per bot: "bp_", a 12-character key id, "_", then 43 random
 * characters. BluePrint sends the key to replace the bot's exhibitor list,
 * and signs exhibitors in to the chat with a JWT (HS256) whose secret is
 * made from the key: SHA-256 of "billie-sign-in:" followed by the key.
 * Billie keeps only the key's hash and that signing secret, so someone who
 * reads Billie's database can't change the list with what they find.
 */

const KEY = /^bp_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const ID_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newKey(): { key: string; keyId: string } {
  let keyId = "";
  for (let i = 0; i < 12; i++) keyId += ID_LETTERS[randomInt(ID_LETTERS.length)];
  return { key: `bp_${keyId}_${randomBytes(32).toString("base64url")}`, keyId };
}

/** The key id of a well-formed key, or null. */
export function keyIdOf(key: string): string | null {
  return KEY.exec(key.trim())?.[1] ?? null;
}

/** What BluePrint signs sign-ins with (hex), made from the key. */
export function signingKeyOf(key: string): string {
  return createHash("sha256").update(`billie-sign-in:${key.trim()}`, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Sign-in tokens

/** The longest a sign-in token may last: as long as a sign-in itself (a show day). */
export const TOKEN_MAX_SECONDS = 12 * 3600;
/** Clocks can differ a little. */
const SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 2048;
const PART = /^[A-Za-z0-9_-]+$/;

export type TokenProblem =
  /** Not a JWT, not HS256, no key id, or no email in "sub". */
  | "malformed"
  /** No BluePrint key with that id, or it's another bot's. */
  | "unknown_key"
  | "bad_signature"
  /** "aud" isn't "billie", or "iss" isn't "blueprint". */
  | "wrong_audience"
  | "expired"
  /** "iat" or "nbf" is in the future: check the clock. */
  | "not_yet"
  /** "exp" is more than 12 hours after "iat", or either is missing. */
  | "too_long"
  /** The email isn't on the bot's exhibitor list. */
  | "not_listed";

export type ReadToken =
  { ok: true; keyId: string; email: string; exp: number } | { ok: false; reason: TokenProblem };

function decode(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parts(token: string): [string, string, string] | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const p = token.trim().split(".");
  return p.length === 3 && p.every((x) => PART.test(x)) ? (p as [string, string, string]) : null;
}

/** The key id a token says it was signed with (to find the key), before anything is checked. */
export function tokenKeyId(token: string): string | null {
  const p = parts(token);
  const header = p ? decode(p[0]) : null;
  const kid = header?.kid;
  return typeof kid === "string" && /^[a-z0-9]{12}$/.test(kid) ? kid : null;
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Checks a token with the bot's signing key: the signature first, then what it says. */
export function readToken(token: string, signingKeyHex: string, now = Date.now()): ReadToken {
  const p = parts(token);
  const header = p ? decode(p[0]) : null;
  const keyId = tokenKeyId(token);
  // Only HS256: never "none", never a key the token chooses.
  if (!p || !header || header.alg !== "HS256" || !keyId) return { ok: false, reason: "malformed" };
  if (header.typ !== undefined && header.typ !== "JWT") return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", Buffer.from(signingKeyHex, "hex"))
    .update(`${p[0]}.${p[1]}`)
    .digest();
  const given = Buffer.from(p[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "bad_signature" };

  const claims = decode(p[1]);
  if (!claims) return { ok: false, reason: "malformed" };
  const aud = claims.aud;
  if (!(aud === "billie" || (Array.isArray(aud) && aud.includes("billie"))))
    return { ok: false, reason: "wrong_audience" };
  if (claims.iss !== "blueprint") return { ok: false, reason: "wrong_audience" };
  const { iat, exp, nbf } = claims;
  if (!isTime(iat) || !isTime(exp) || exp - iat > TOKEN_MAX_SECONDS)
    return { ok: false, reason: "too_long" };
  const secs = now / 1000;
  if (iat > secs + SKEW_SECONDS || (isTime(nbf) && nbf > secs + SKEW_SECONDS))
    return { ok: false, reason: "not_yet" };
  if (exp <= secs - SKEW_SECONDS) return { ok: false, reason: "expired" };
  const sub = typeof claims.sub === "string" ? claims.sub.trim().toLowerCase() : "";
  const [email] = emailsIn(sub);
  if (!email || email !== sub) return { ok: false, reason: "malformed" };
  return { ok: true, keyId, email, exp };
}

/** A sign-in token, made as BluePrint makes it (for tests and the guide's example). */
export function signToken(
  key: string,
  email: string,
  opts: { now?: number; seconds?: number; claims?: Record<string, unknown> } = {},
): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const head = b64({ alg: "HS256", typ: "JWT", kid: keyIdOf(key) });
  const body = b64({
    iss: "blueprint",
    aud: "billie",
    sub: email,
    iat: now,
    exp: now + (opts.seconds ?? 7200),
    ...opts.claims,
  });
  const sig = createHmac("sha256", Buffer.from(signingKeyOf(key), "hex"))
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${sig}`;
}

// ---------------------------------------------------------------------------
// The exhibitor list BluePrint sends

export type SyncRow = ListedExhibitor & { externalId: string };
export type ReadSync = {
  rows: SyncRow[];
  /** The field names kept, in the order they first appear. */
  columns: string[];
  /** Exhibitors with no usable email address (left out, as in a spreadsheet). */
  skipped: number;
};

const text = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) =>
    v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim().slice(0, MAX_VALUE),
  );
const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const row = z.object({
  id: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().min(1, "Give each exhibitor an id.").max(200)),
  company: text,
  stand: text,
  name: text,
  emails: z.array(z.string().max(320)).max(20).nullish(),
  fields: z.record(z.string(), fieldValue).nullish(),
});
const body = z.object({ exhibitors: z.array(z.unknown()) });

function fieldText(v: z.infer<typeof fieldValue>): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v).replace(/\s+/g, " ").trim().slice(0, MAX_VALUE);
}

/** BluePrint's list, checked and tidied the way a spreadsheet is; or what's wrong with it. */
export function readSync(
  input: unknown,
): { ok: true; list: ReadSync } | { ok: false; error: string } {
  const top = body.safeParse(input);
  if (!top.success)
    return { ok: false, error: 'Send JSON with an "exhibitors" list: { "exhibitors": [ … ] }.' };
  const all = top.data.exhibitors;
  if (all.length > MAX_EXHIBITORS)
    return {
      ok: false,
      error: `That's ${all.length.toLocaleString("en-GB")} exhibitors: Billie takes up to ${MAX_EXHIBITORS.toLocaleString("en-GB")} per show.`,
    };
  const rows: SyncRow[] = [];
  const columns: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (let i = 0; i < all.length; i++) {
    const parsed = row.safeParse(all[i]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const at = ["exhibitors", i, ...issue.path].join(".");
      return { ok: false, error: `Check ${at}: ${issue.message}` };
    }
    const r = parsed.data;
    if (seen.has(r.id))
      return {
        ok: false,
        error: `Exhibitor id "${r.id.slice(0, 60)}" is in the list twice. Each exhibitor needs its own id.`,
      };
    seen.add(r.id);
    const emails = [...new Set((r.emails ?? []).flatMap((e) => emailsIn(e)))];
    if (!emails.length) {
      skipped++;
      continue;
    }
    const fields: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(r.fields ?? {})) {
      const key = rawKey.replace(/\s+/g, " ").trim().slice(0, MAX_HEADING);
      const value = fieldText(rawValue);
      if (!key || !value) continue;
      if (!columns.includes(key)) {
        if (columns.length >= MAX_FIELDS) continue; // beyond the 40 kept, as in a spreadsheet
        columns.push(key);
      }
      fields[key] = value;
    }
    rows.push({
      externalId: r.id,
      company: r.company,
      stand: r.stand,
      name: r.name,
      emails,
      fields,
    });
  }
  return { ok: true, list: { rows, columns, skipped } };
}

/** Has anything about this exhibitor changed since the last update? */
export function sameExhibitor(a: ListedExhibitor, b: ListedExhibitor): boolean {
  const sorted = (f: Record<string, string>) =>
    JSON.stringify(Object.entries(f).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return (
    a.company === b.company &&
    a.stand === b.stand &&
    a.name === b.name &&
    a.emails.length === b.emails.length &&
    a.emails.every((e, i) => e === b.emails[i]) &&
    sorted(a.fields) === sorted(b.fields)
  );
}
