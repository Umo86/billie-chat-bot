import { headers } from "next/headers";
import { z } from "zod";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { chatRequests, exhibitors } from "@/lib/db/schema";
import { bearer } from "@/lib/chat/token";
import { json, problem } from "@/lib/chat/public";
import { allow, clientKey, ipFrom, LIMITS } from "@/lib/rate-limit";
import { botForKey } from "@/lib/exhibitors/blueprint";
import { requestRef } from "@/lib/requests/rules";
import { updateRequestFromBlueprint } from "@/lib/requests/service";
import type { ContactDetails } from "@/lib/types";

/**
 * Tasks done in the chat, for BluePrint, the exhibitor manual (server to
 * server; docs/blueprint.md):
 *
 *   GET  /api/public/blueprint/tasks?after=1041   what exhibitors sent through the
 *        bot's chat after request 1041 (oldest first, up to 100), with orders
 *   POST /api/public/blueprint/tasks   { "ref": 1042, "status": "done", "note": "…" }
 *        how one is going: the exhibitor hears, as when the team changes it
 *
 * Both need "Authorization: Bearer <the bot's key>"; the key says which bot,
 * and only that bot's requests are ever seen or changed.
 */
export const dynamic = "force-dynamic";

const WRONG_KEY =
  "That key isn't right, or it's been replaced. Make a new key on the bot's Exhibitors step in Billie, and put it in BluePrint.";
const PAGE = 100;

async function caller(request: Request) {
  const ip = clientKey(ipFrom(await headers()));
  if (!(await allow(`blueprint:ip:${ip}`, LIMITS.blueprintIp)))
    return problem(429, "Too many requests. Wait a few minutes, then try again.");
  const found = await botForKey(bearer(request.headers.get("authorization")));
  if (!found)
    return json({ error: WRONG_KEY }, 401, { "WWW-Authenticate": 'Bearer realm="billie"' });
  if (!(await allow(`blueprint:tasks:${found.keyId}`, LIMITS.blueprintTasks)))
    return problem(
      429,
      "That's a lot of requests this hour. Check for new tasks every minute or so.",
    );
  return found;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const found = await caller(request);
    if (found instanceof Response) return found;
    const raw = new URL(request.url).searchParams.get("after") ?? "0";
    const after = /^\d{1,10}$/.test(raw) ? Number(raw) : null;
    if (after === null)
      return problem(400, 'Give "after" as the last request number you have, or 0.');
    const rows = await db
      .select({ r: chatRequests, externalId: exhibitors.externalId })
      .from(chatRequests)
      .leftJoin(exhibitors, eq(exhibitors.id, chatRequests.exhibitorId))
      .where(and(eq(chatRequests.botId, found.botId), gt(chatRequests.ref, after)))
      .orderBy(asc(chatRequests.ref))
      .limit(PAGE);
    const tasks = rows.map(({ r, externalId }) => {
      const contact = r.contact as ContactDetails;
      return {
        ref: requestRef(r.ref),
        number: r.ref,
        type: r.typeName,
        typeId: r.typeId,
        status: r.status,
        // BluePrint's own id for the exhibitor, when the list came from BluePrint and they were signed in.
        exhibitorId: externalId ?? null,
        exhibitor: {
          name: contact.name ?? "",
          company: contact.company ?? "",
          stand: contact.stand ?? "",
          email: contact.email ?? "",
          phone: contact.phone ?? "",
        },
        answers: r.answers,
        order: r.order ?? null,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
    return json({ tasks, next: rows.at(-1)?.r.ref ?? after, more: rows.length === PAGE });
  } catch (err) {
    console.error("blueprint tasks failed", err instanceof Error ? err.message : err);
    return problem(500, "Something went wrong. Try again in a moment.");
  }
}

const statusBody = z.object({
  ref: z.union([z.number().int().positive(), z.string().regex(/^R?-?\d{1,10}$/i)]),
  status: z.enum(["in_progress", "done", "declined"]),
  note: z.string().max(2000).optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const found = await caller(request);
    if (found instanceof Response) return found;
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
      return problem(415, "Send it as JSON (Content-Type: application/json).");
    const raw = await request.text();
    if (raw.length > 10_000) return problem(413, "That's too long.");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return problem(400, "That isn't JSON.");
    }
    const parsed = statusBody.safeParse(body);
    if (!parsed.success)
      return problem(
        400,
        'Send { "ref": 1042, "status": "in_progress" | "done" | "declined", "note": "optional" }.',
      );
    const ref = Number(String(parsed.data.ref).replace(/\D/g, ""));
    const changed = await updateRequestFromBlueprint(found.botId, ref, {
      status: parsed.data.status,
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    });
    if (!changed) return problem(404, `There's no request ${requestRef(ref)} for this bot.`);
    return json({ ok: true, ref: requestRef(ref), status: parsed.data.status });
  } catch (err) {
    console.error("blueprint task update failed", err instanceof Error ? err.message : err);
    return problem(500, "Something went wrong. Try again in a moment.");
  }
}
