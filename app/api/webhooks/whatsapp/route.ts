import { timingSafeEqual } from "node:crypto";
import { whatsappConfigured } from "@/lib/config";
import { parseInbound, verifySignature } from "@/lib/channels/whatsapp";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";

/**
 * Meta's WhatsApp Cloud API webhook. GET: the one-off subscription check.
 * POST: incoming messages, signed with the app secret; each is queued and
 * answered straight after this responds (Meta wants a 200 within seconds).
 */
export const dynamic = "force-dynamic";

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = process.env.WHATSAPP_VERIFY_TOKEN?.trim();
  if (
    token &&
    url.searchParams.get("hub.mode") === "subscribe" &&
    same(url.searchParams.get("hub.verify_token") ?? "", token)
  ) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request) {
  if (!whatsappConfigured()) return new Response("Not configured", { status: 404 });
  const raw = await request.text();
  if (raw.length > 512_000) return new Response("Too large", { status: 413 });
  if (
    !verifySignature(
      raw,
      request.headers.get("x-hub-signature-256"),
      process.env.WHATSAPP_APP_SECRET!,
    )
  )
    return new Response("Bad signature", { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const messages = parseInbound(payload);
  for (const m of messages) {
    await enqueue(
      "whatsapp_inbound",
      { message: { ...m, timestamp: m.timestamp.toISOString() } },
      { dedupeKey: `wa:${m.id}` },
    );
  }
  if (messages.length) await kickJobs();
  return Response.json({ received: messages.length });
}
