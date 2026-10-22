import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { emailThreads, settings } from "@/lib/db/schema";
import { outlookConfigured } from "@/lib/config";
import { enqueue } from "@/lib/jobs/queue";
import { getSettings } from "@/lib/settings";

/**
 * The ops mailbox in Outlook 365, through Microsoft Graph with an app
 * registration IT limits to that one mailbox (application permission
 * Mail.ReadWrite; an Exchange application access policy or RBAC scopes it).
 * Billie reads new mail with a delta query, drafts replies in the same
 * thread and tags the email with Outlook categories. It never sends.
 */
const GRAPH = "https://graph.microsoft.com/v1.0";
let token: { value: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const res = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID!,
      client_secret: process.env.MS_CLIENT_SECRET!,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`Microsoft sign-in failed: ${json.error_description ?? res.status}`);
  token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return token.value;
}

async function graph<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url.startsWith("http") ? url : `${GRAPH}${url}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      "content-type": "application/json",
      prefer: 'outlook.body-content-type="text"',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Graph ${res.status}: ${json.error?.message ?? "request failed"}`);
  return json;
}

function mailbox(): string {
  return encodeURIComponent(process.env.MS_MAILBOX!.trim());
}

type GraphMessage = {
  id: string;
  conversationId?: string;
  subject?: string;
  isDraft?: boolean;
  receivedDateTime?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  body?: { content?: string };
  "@removed"?: unknown;
};

/** New mail since the last sync, recorded once each (unique Outlook id) and queued for drafting. */
export async function syncMailbox(now = new Date()): Promise<{ added: number }> {
  if (!outlookConfigured()) return { added: 0 };
  const s = await getSettings();
  const first = !s.outlookDeltaLink;
  let url =
    s.outlookDeltaLink ??
    `/users/${mailbox()}/mailFolders/inbox/messages/delta?$select=id,conversationId,subject,isDraft,receivedDateTime,from,body`;
  const own = process.env.MS_MAILBOX!.trim().toLowerCase();
  // The first sync only takes the last two days, not years of history.
  const since = first ? now.getTime() - 2 * 86_400_000 : 0;
  let added = 0;
  for (let page = 0; page < 50; page++) {
    const res = await graph<{ value: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(url);
    for (const m of res.value) {
      if (m["@removed"] || m.isDraft) continue;
      const from = m.from?.emailAddress?.address?.toLowerCase() ?? "";
      if (!from || from === own) continue;
      const received = m.receivedDateTime ? new Date(m.receivedDateTime) : now;
      if (received.getTime() < since) continue;
      const [row] = await db
        .insert(emailThreads)
        .values({
          source: "outlook",
          externalId: m.id,
          threadKey: m.conversationId ?? null,
          botId: s.emailBotId,
          fromName: (m.from?.emailAddress?.name ?? "").slice(0, 200),
          fromEmail: from.slice(0, 200),
          subject: (m.subject ?? "").slice(0, 300),
          body: (m.body?.content ?? "").slice(0, 20_000),
          receivedAt: received,
        })
        .onConflictDoNothing({ target: emailThreads.externalId })
        .returning({ id: emailThreads.id });
      if (row) {
        await enqueue("process_email", { emailId: row.id }, { dedupeKey: `email:${row.id}` });
        added++;
      }
    }
    if (res["@odata.nextLink"]) {
      url = res["@odata.nextLink"];
      continue;
    }
    if (res["@odata.deltaLink"]) {
      await db.update(settings).set({ outlookDeltaLink: res["@odata.deltaLink"] }).where(eq(settings.id, "main"));
    }
    break;
  }
  return { added };
}

/** A reply draft in the same Outlook thread, with Billie's text above the quoted email. */
export async function createReplyDraft(messageId: string, text: string): Promise<string> {
  const draft = await graph<{ id: string }>(`/users/${mailbox()}/messages/${encodeURIComponent(messageId)}/createReply`, {
    method: "POST",
    body: JSON.stringify({ comment: text }),
  });
  return draft.id;
}

export async function setCategories(messageId: string, categories: string[]): Promise<void> {
  await graph(`/users/${mailbox()}/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ categories }),
  });
}
