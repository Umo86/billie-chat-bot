import "server-only";
import { timingSafeEqual } from "node:crypto";

/** True when the request carries Vercel Cron's "Authorization: Bearer <CRON_SECRET>". */
export function cronAuthorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
