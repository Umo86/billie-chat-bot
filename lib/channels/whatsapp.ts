import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * WhatsApp Cloud API (direct with Meta, no reseller). Webhook signature
 * checks and payload parsing are pure and unit-tested; sending is a thin
 * client. One number serves both bots: the first reply asks "Visiting or
 * exhibiting?" (lib/channels/whatsapp-inbound.ts routes the answer).
 */
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice(7), "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type InboundMessage = {
  id: string;
  from: string;
  profileName: string;
  timestamp: Date;
  /** Typed text, or the title of a tapped button. */
  text: string;
  /** The id of a tapped reply button ("visitor" / "exhibitor"), when it was one. */
  buttonId: string | null;
};

type WaPayload = {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: {
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
          button?: { payload?: string; text?: string };
        }[];
      };
    }[];
  }[];
};

/** Messages people sent (status updates and unsupported types are skipped). */
export function parseInbound(payload: unknown): InboundMessage[] {
  const p = payload as WaPayload;
  if (p?.object !== "whatsapp_business_account") return [];
  const out: InboundMessage[] = [];
  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const names = new Map((change.value.contacts ?? []).map((c) => [c.wa_id ?? "", c.profile?.name ?? ""]));
      for (const m of change.value.messages ?? []) {
        if (!m.id || !m.from) continue;
        let text = "";
        let buttonId: string | null = null;
        if (m.type === "text") text = m.text?.body ?? "";
        else if (m.type === "interactive" && m.interactive?.type === "button_reply") {
          text = m.interactive.button_reply?.title ?? "";
          buttonId = m.interactive.button_reply?.id ?? null;
        } else if (m.type === "button") {
          text = m.button?.text ?? "";
          buttonId = m.button?.payload ?? null;
        } else continue;
        if (!text.trim() && !buttonId) continue;
        out.push({
          id: m.id,
          from: m.from,
          profileName: names.get(m.from) ?? "",
          timestamp: new Date(Number(m.timestamp ?? 0) * 1000 || Date.now()),
          text: text.trim(),
          buttonId,
        });
      }
    }
  }
  return out;
}

/** Free-form replies are allowed for 24 hours after the person's last message. */
export function withinReplyWindow(lastInboundAt: Date | null, now = new Date()): boolean {
  return Boolean(lastInboundAt && now.getTime() - lastInboundAt.getTime() < 24 * 3_600_000);
}

/** One complete message per answer (each reply is billed), sources on a last line. */
export function formatAnswer(text: string, sources: { title: string; label: string }[]): string {
  const src = sources.map((s) => [s.title, s.label].filter(Boolean).join(", ")).join("; ");
  return (src ? `${text}\n\nSource: ${src}` : text).slice(0, 4096);
}

function endpoint(): string {
  const version = process.env.WHATSAPP_API_VERSION?.trim() || "v23.0";
  return `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

async function post(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${json.error?.message ?? "send failed"}`);
  return json.messages?.[0]?.id ?? null;
}

export function sendText(to: string, text: string): Promise<string | null> {
  return post({ to, type: "text", text: { body: text.slice(0, 4096), preview_url: false } });
}

export function sendButtons(to: string, text: string, buttons: { id: string; title: string }[]): Promise<string | null> {
  return post({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: text.slice(0, 1024) },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  });
}
