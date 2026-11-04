import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, exhibitorLists } from "@/lib/db/schema";
import { bearer } from "@/lib/chat/token";
import { json, problem } from "@/lib/chat/public";
import { allow, clientKey, ipFrom, LIMITS } from "@/lib/rate-limit";
import { UserError } from "@/lib/errors";
import { botForKey, syncFromBlueprint } from "@/lib/exhibitors/blueprint";
import { readSync } from "@/lib/exhibitors/blueprint-rules";

/**
 * BluePrint, the exhibitor manual, keeps a bot's exhibitor list up to date
 * (server to server; docs/blueprint.md has the details):
 *
 *   GET  /api/public/blueprint/exhibitors   checks the key: which bot, how many exhibitors
 *   POST /api/public/blueprint/exhibitors   { "exhibitors": [ … ] } replaces the whole list
 *
 * Both need "Authorization: Bearer <the bot's key>". The key says which bot.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Under Vercel's 4.5 MB request limit, and far more than 5,000 exhibitors need. */
const MAX_BYTES = 4 * 1024 * 1024;

const WRONG_KEY =
  "That key isn't right, or it's been replaced. Make a new key on the bot's Exhibitors step in Billie, and put it in BluePrint.";

/** The bot whose key this is, or the response to send instead. */
async function caller(request: Request) {
  const ip = clientKey(ipFrom(await headers()));
  // Counted before the key is checked, so nobody can try keys quickly.
  if (!(await allow(`blueprint:ip:${ip}`, LIMITS.blueprintIp)))
    return problem(429, "Too many requests. Wait a few minutes, then try again.");
  const found = await botForKey(bearer(request.headers.get("authorization")));
  if (!found)
    return json({ error: WRONG_KEY }, 401, { "WWW-Authenticate": 'Bearer realm="billie"' });
  return found;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const found = await caller(request);
    if (found instanceof Response) return found;
    const [bot, list] = await Promise.all([
      db.query.bots.findFirst({
        where: eq(bots.id, found.botId),
        columns: { name: true, showName: true, audience: true },
      }),
      db.query.exhibitorLists.findFirst({
        where: eq(exhibitorLists.botId, found.botId),
        columns: { rows: true, source: true, uploadedAt: true },
      }),
    ]);
    return json({
      bot: bot?.name ?? "",
      show: bot?.showName ?? "",
      exhibitors: list?.rows ?? 0,
      from: list ? (list.source === "blueprint" ? "blueprint" : "spreadsheet") : null,
      updatedAt: list?.uploadedAt.toISOString() ?? null,
    });
  } catch (err) {
    console.error("blueprint check failed", err instanceof Error ? err.message : err);
    return problem(500, "Something went wrong. Try again in a moment.");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const found = await caller(request);
    if (found instanceof Response) return found;
    if (!(await allow(`blueprint:sync:${found.keyId}`, LIMITS.blueprintSync)))
      return problem(
        429,
        "That's a lot of updates this hour. Send the whole list at most once a minute.",
      );
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
      return problem(415, "Send the list as JSON (Content-Type: application/json).");
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES)
      return problem(413, "That's over 4 MB. Leave out fields Billie doesn't need.");
    const raw = await request.text();
    if (raw.length > MAX_BYTES)
      return problem(413, "That's over 4 MB. Leave out fields Billie doesn't need.");
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return problem(400, "That isn't valid JSON.");
    }
    const read = readSync(input);
    if (!read.ok) return problem(400, read.error);
    // An empty list is far more likely a mistake than a show with nobody exhibiting.
    if (!read.list.rows.length)
      return problem(
        422,
        "No exhibitors with an email address in the list, so nothing was changed. Billie needs at least one.",
      );
    return json(await syncFromBlueprint(found.botId, read.list));
  } catch (err) {
    if (err instanceof UserError) return problem(409, err.message);
    console.error("blueprint sync failed", err instanceof Error ? err.message : err);
    return problem(500, "Something went wrong. Try again in a moment.");
  }
}
