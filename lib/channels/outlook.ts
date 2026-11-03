import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botMailboxes, bots, emailThreads } from "@/lib/db/schema";
import { microsoftConfigured } from "@/lib/config";
import { enqueue } from "@/lib/jobs/queue";
import {
  GraphError,
  MicrosoftSignInError,
  mailboxProblem,
  replyHtml,
  skipIncoming,
  spliceReply,
  syncWasReset,
  withBillieCategories,
} from "@/lib/emails/mailbox-rules";

/**
 * The event mailboxes in Microsoft 365, through Microsoft Graph. One app
 * registration (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET) with the
 * application permission Mail.ReadWrite, which IT limits to the event
 * mailboxes (RBAC for Applications, or an application access policy).
 * Each bot can have one mailbox. Billie reads new mail in its inbox with a
 * delta query, saves a reply draft in the same thread and tags the email
 * with Outlook categories. It never sends.
 */
const GRAPH = "https://graph.microsoft.com/v1.0";
/** Message ids that stay the same when someone moves the email to another folder. */
const IMMUTABLE = 'IdType="ImmutableId"';
let token: { value: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(process.env.MS_TENANT_ID!.trim())}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID!.trim(),
        client_secret: process.env.MS_CLIENT_SECRET!.trim(),
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  // Microsoft's error code only (e.g. "invalid_client"); never the request.
  if (!res.ok || !json.access_token)
    throw new MicrosoftSignInError(`Microsoft sign-in failed: ${json.error ?? res.status}`);
  token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return token.value;
}

async function graph<T>(url: string, init: RequestInit & { prefer?: string[] } = {}): Promise<T> {
  const { prefer = [], headers, ...rest } = init;
  // Links Graph hands back (next page, next sync) must stay on Graph: they carry Billie's token.
  if (url.startsWith("https://") && !url.startsWith(`${GRAPH}/`))
    throw new GraphError(400, "UnexpectedLink", "Graph returned a link to another host");
  const res = await fetch(url.startsWith("https://") ? url : `${GRAPH}${url}`, {
    ...rest,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      "content-type": "application/json",
      prefer: [IMMUTABLE, ...prefer].join(", "),
      ...(headers ?? {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204 || res.status === 202) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as T & {
    error?: { code?: string; message?: string };
  };
  if (!res.ok)
    throw new GraphError(
      res.status,
      json.error?.code ?? "",
      `Graph ${res.status}: ${json.error?.code ?? "request failed"}`,
    );
  return json;
}

const user = (mailbox: string) => `/users/${encodeURIComponent(mailbox)}`;
const message = (mailbox: string, id: string) =>
  `${user(mailbox)}/messages/${encodeURIComponent(id)}`;

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

type SyncBox = { id: string; botId: string; address: string; deltaLink: string | null };

/** How far back the first sync of a mailbox looks: new mail only, not years of history. */
const FIRST_SYNC_DAYS = 2;

/** One mailbox: new mail since the last sync, recorded once each and queued for a draft. */
async function syncMailbox(box: SyncBox, now: Date, resetOnce = true): Promise<number> {
  const since = new Date(now.getTime() - FIRST_SYNC_DAYS * 86_400_000).toISOString();
  let url =
    box.deltaLink ??
    `${user(box.address)}/mailFolders/inbox/messages/delta?` +
      new URLSearchParams({
        $select: "id,conversationId,subject,isDraft,receivedDateTime,from,body",
        $filter: `receivedDateTime ge ${since}`,
      }).toString();
  let added = 0;
  for (let page = 0; page < 20; page++) {
    let res: { value: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
    try {
      res = await graph(url, {
        prefer: ['outlook.body-content-type="text"', "odata.maxpagesize=50"],
      });
    } catch (err) {
      if (resetOnce && box.deltaLink && syncWasReset(err)) {
        // The sync point expired. Start again: emails already recorded are skipped.
        await db.update(botMailboxes).set({ deltaLink: null }).where(eq(botMailboxes.id, box.id));
        return syncMailbox({ ...box, deltaLink: null }, now, false);
      }
      throw err;
    }
    for (const m of res.value) {
      if (m["@removed"] || m.isDraft) continue;
      const from = (m.from?.emailAddress?.address ?? "").trim().toLowerCase();
      const subject = m.subject ?? "";
      if (skipIncoming({ from, subject, mailbox: box.address })) continue;
      const [row] = await db
        .insert(emailThreads)
        .values({
          source: "outlook",
          externalId: m.id,
          threadKey: m.conversationId ?? null,
          mailbox: box.address,
          botId: box.botId,
          fromName: (m.from?.emailAddress?.name ?? "").slice(0, 200),
          fromEmail: from.slice(0, 200),
          subject: subject.slice(0, 300),
          body: (m.body?.content ?? "").slice(0, 20_000),
          receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime) : now,
        })
        .onConflictDoNothing({ target: emailThreads.externalId })
        .returning({ id: emailThreads.id });
      if (row) {
        await enqueue("process_email", { emailId: row.id }, { dedupeKey: `email:${row.id}` });
        added++;
      }
    }
    // Carry on from here next time, even mid-way through a busy inbox.
    const next = res["@odata.nextLink"] ?? res["@odata.deltaLink"];
    if (next) {
      await db.update(botMailboxes).set({ deltaLink: next }).where(eq(botMailboxes.id, box.id));
      box = { ...box, deltaLink: next };
    }
    if (!res["@odata.nextLink"]) break;
    url = res["@odata.nextLink"];
  }
  return added;
}

/** Enabled mailboxes of bots that haven't been deleted. */
async function mailboxesToSync(): Promise<SyncBox[]> {
  return db
    .select({
      id: botMailboxes.id,
      botId: botMailboxes.botId,
      address: botMailboxes.address,
      deltaLink: botMailboxes.deltaLink,
    })
    .from(botMailboxes)
    .innerJoin(bots, eq(bots.id, botMailboxes.botId))
    .where(and(eq(botMailboxes.enabled, true), isNull(bots.deletedAt)));
}

export async function hasMailboxToSync(): Promise<boolean> {
  return (await mailboxesToSync()).length > 0;
}

/**
 * Every event mailbox, a few at a time (the minute job). One mailbox failing
 * never stops the others: its problem is saved, in words, for the screen.
 */
export async function syncAllMailboxes(
  now = new Date(),
): Promise<{ mailboxes: number; added: number; failed: number }> {
  if (!microsoftConfigured()) return { mailboxes: 0, added: 0, failed: 0 };
  const boxes = await mailboxesToSync();
  let added = 0;
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < boxes.length) {
      const box = boxes[next++];
      try {
        added += await syncMailbox(box, now);
        await db
          .update(botMailboxes)
          .set({ lastSyncedAt: now, lastError: null })
          .where(eq(botMailboxes.id, box.id));
      } catch (err) {
        failed++;
        console.warn("mailbox sync failed", err instanceof Error ? err.message : err);
        await db
          .update(botMailboxes)
          .set({ lastError: mailboxProblem(err) })
          .where(eq(botMailboxes.id, box.id));
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { mailboxes: boxes.length, added, failed };
}

/**
 * A reply draft in the same Outlook thread, in the mailbox's Drafts:
 * Billie's text above the quoted email, with its line breaks kept.
 */
export async function createReplyDraft(
  mailbox: string,
  messageId: string,
  text: string,
): Promise<string> {
  const draft = await graph<{ id: string; body?: { content?: string } }>(
    `${message(mailbox, messageId)}/createReply`,
    { method: "POST", body: JSON.stringify({}), prefer: ['outlook.body-content-type="html"'] },
  );
  try {
    await graph(message(mailbox, draft.id), {
      method: "PATCH",
      body: JSON.stringify({
        body: {
          contentType: "HTML",
          content: spliceReply(draft.body?.content ?? "", replyHtml(text)),
        },
      }),
    });
  } catch (err) {
    // Don't leave an empty draft behind; the job tries again.
    await graph(message(mailbox, draft.id), { method: "DELETE" }).catch(() => undefined);
    throw err;
  }
  return draft.id;
}

/**
 * Removes one of Billie's own earlier drafts (when the team asks for a new
 * one). Only while it is still an unsent draft; it goes to Deleted Items.
 */
export async function removeOwnDraft(mailbox: string, draftId: string): Promise<void> {
  try {
    const m = await graph<{ isDraft?: boolean }>(`${message(mailbox, draftId)}?$select=isDraft`);
    if (m.isDraft) await graph(message(mailbox, draftId), { method: "DELETE" });
  } catch (err) {
    if (err instanceof GraphError && err.status === 404) return; // already gone
    throw err;
  }
}

/** Billie's Outlook categories on the email; the team's own categories stay. */
export async function tagMessage(
  mailbox: string,
  messageId: string,
  categories: string[],
): Promise<void> {
  const m = await graph<{ categories?: string[] }>(
    `${message(mailbox, messageId)}?$select=categories`,
  );
  await graph(message(mailbox, messageId), {
    method: "PATCH",
    body: JSON.stringify({ categories: withBillieCategories(m.categories ?? [], categories) }),
  });
}

/** Checks Billie can open the mailbox's inbox: null when it can, else the problem in words. */
export async function checkMailbox(mailbox: string): Promise<string | null> {
  if (!microsoftConfigured())
    return "Microsoft 365 isn't connected yet. An admin adds MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET in Vercel.";
  try {
    await graph(`${user(mailbox)}/mailFolders/inbox?$select=id`);
    return null;
  } catch (err) {
    return mailboxProblem(err);
  }
}
