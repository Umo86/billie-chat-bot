import "server-only";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { derivedSecret } from "@/lib/auth/config";

/**
 * One rate limiter, in the database (rate_limits): fixed windows counted by
 * a single atomic upsert, so it works across every serverless instance with
 * no extra service. Keys are HMACs: no IPs or emails stored in clear.
 */
export type Rule = { window: number; max: number }; // window in seconds

export const LIMITS = {
  /** Public chat, per visitor IP and bot. */
  chatMessage: { window: 300, max: 40 },
  /** New chats, per IP. */
  chatStart: { window: 3600, max: 30 },
  /** Per chat: stops one tab hammering Claude. */
  chatPerConversation: { window: 3600, max: 120 },
  /** Per visitor address per day, across every bot. */
  chatDaily: { window: 86_400, max: 300 },
  /** WhatsApp, per sender. */
  whatsappSender: { window: 3600, max: 40 },
  whatsappSenderDaily: { window: 86_400, max: 200 },
  /** Staff sign-in, per email and per IP. */
  signIn: { window: 900, max: 10 },
  signInIp: { window: 900, max: 50 },
  /** Invitation and set-up pages. */
  invite: { window: 900, max: 20 },
} as const satisfies Record<string, Rule>;

function secret(): string {
  return derivedSecret("rate-limit") ?? "billie-dev";
}

export function bucketKey(raw: string): string {
  return createHmac("sha256", secret()).update(raw).digest("hex");
}

/** Count this request; allowed while the window's count is within the rule. */
export async function consume(
  raw: string,
  rule: Rule,
  now = Date.now(),
): Promise<{ allowed: boolean; retryAfter: number }> {
  const since = now - rule.window * 1000;
  const rows = await query<{ count: number; window_start: string | number }>(
    db,
    sql`
    INSERT INTO rate_limits (key, count, window_start) VALUES (${bucketKey(raw)}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start <= ${since} THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start <= ${since} THEN ${now} ELSE rate_limits.window_start END
    RETURNING count, window_start`,
  );
  const row = rows[0];
  const allowed = Number(row.count) <= rule.max;
  const retryAfter = Math.max(
    1,
    Math.ceil((Number(row.window_start) + rule.window * 1000 - now) / 1000),
  );
  return { allowed, retryAfter };
}

/** Never blocks when the limiter itself is down: a database blip shouldn't stop chats. */
export async function allow(raw: string, rule: Rule): Promise<boolean> {
  if (process.env.RATE_LIMIT === "off" && process.env.VERCEL_ENV !== "production") return true;
  try {
    return (await consume(raw, rule)).allowed;
  } catch (err) {
    console.error("rate limit unavailable", err instanceof Error ? err.message : err);
    return true;
  }
}

/** Removes windows that ended more than a day ago (daily job). */
export async function pruneRateLimits(now = Date.now()): Promise<number> {
  const rows = await query(
    db,
    sql`DELETE FROM rate_limits WHERE window_start < ${now - 86_400_000} RETURNING key`,
  );
  return rows.length;
}

/**
 * The rate-limit identity for an address: IPv4 as it is; IPv6 by its /64
 * network, because one connection is usually given a whole /64 and could
 * otherwise rotate through addresses to dodge the limits.
 */
export function clientKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [
    ...left,
    ...new Array(Math.max(0, 8 - left.length - right.length)).fill("0"),
    ...right,
  ];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** The caller's IP on Vercel (x-real-ip), else the first x-forwarded-for, else "unknown". */
export function ipFrom(headers: Headers): string {
  return (
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
