import { vi } from "vitest";

/**
 * Stand-ins for Microsoft 365 (Graph and sign-in) and Teams workflows, for
 * DB tests: fetch is swapped for this, which answers Billie's requests and
 * records them. Nothing reaches Microsoft.
 */
export const TEAMS =
  "https://prod-12.uksouth.logic.azure.com:443/workflows/test/triggers/manual/paths/invoke?sig=test-signature";

/** The company's "Teams message to a person" workflow, in tests. */
export const DIRECT =
  "https://prod-34.uksouth.logic.azure.com:443/workflows/direct/triggers/manual/paths/invoke?sig=direct-signature";

export type Call = { method: string; url: string; body: unknown; ifMatch?: string };
type Box = { status?: number; value?: unknown[]; expiredToken?: string };

/**
 * Answers Billie's requests to Microsoft and records them. Drafts have a
 * version (etag) that a delete must match, as Outlook's do; `edit(id)` is a
 * person changing one in Outlook. `refuseDrafts` makes saving drafts fail
 * with that status (403: read-only access).
 */
export function fakeMicrosoft(inbox: Record<string, Box>, opts: { refuseDrafts?: number } = {}) {
  const calls: Call[] = [];
  const etags = new Map<string, string>(); // draft id → its current version
  let drafts = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const refuse = (status: number) =>
    json({ error: { code: status === 403 ? "ErrorAccessDenied" : "ServerBusy" } }, status);
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : null;
    const headers = new Headers(init?.headers);
    const ifMatch = headers.get("if-match") ?? undefined;
    calls.push({
      method,
      url,
      body: raw?.startsWith("{") ? JSON.parse(raw) : raw,
      ...(ifMatch ? { ifMatch } : {}),
    });
    if (url.startsWith("https://login.microsoftonline.com/"))
      return json({ access_token: "token", expires_in: 3600 });
    if (url.startsWith("https://prod-12.uksouth.logic.azure.com") || url.startsWith(DIRECT))
      return new Response(null, { status: 202 });
    const delta = /\/users\/([^/]+)\/mailFolders\/inbox\/messages\/delta/.exec(url);
    if (delta) {
      const box = inbox[decodeURIComponent(delta[1])];
      if (box?.status)
        return json(
          { error: { code: "ErrorAccessDenied", message: "Access is denied." } },
          box.status,
        );
      if (box?.expiredToken && url.includes(box.expiredToken))
        return json({ error: { code: "SyncStateNotFound", message: "Expired." } }, 410);
      return json({
        value: box?.value ?? [],
        "@odata.deltaLink": `https://graph.microsoft.com/v1.0/users/${delta[1]}/mailFolders/inbox/messages/delta?$deltatoken=next`,
      });
    }
    if (url.endsWith("/mailFolders/inbox?$select=id")) return json({ id: "inbox" });
    const newDraft = (body: unknown) => {
      drafts++;
      const id = `draft-${drafts}`;
      etags.set(id, `W/"${id}-v1"`);
      return json({ id, "@odata.etag": etags.get(id), ...(body as object) }, 201);
    };
    if (url.endsWith("/createReply")) {
      if (opts.refuseDrafts) return refuse(opts.refuseDrafts);
      return newDraft({
        body: { content: '<html><body dir="ltr"><div>Original email</div></body></html>' },
      });
    }
    if (method === "POST" && /\/users\/[^/]+\/messages$/.test(url)) {
      if (opts.refuseDrafts) return refuse(opts.refuseDrafts);
      return newDraft({});
    }
    const item = /\/messages\/([^/?]+)/.exec(url)?.[1];
    const id = item ? decodeURIComponent(item) : "";
    if (method === "GET" && url.includes("$select=categories"))
      return json({ categories: ["VIP"] });
    if (method === "PATCH") {
      if (etags.has(id)) {
        const next = `W/"${id}-v${Number(/v(\d+)"$/.exec(etags.get(id)!)?.[1] ?? 1) + 1}"`;
        etags.set(id, next);
        return json({ id, "@odata.etag": next });
      }
      return json({});
    }
    if ((method === "DELETE" || url.endsWith("/permanentDelete")) && etags.has(id)) {
      if (ifMatch && ifMatch !== etags.get(id))
        return json({ error: { code: "ErrorIrresolvableConflict" } }, 412);
      etags.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE" || url.endsWith("/permanentDelete"))
      return json({ error: { code: "ErrorItemNotFound" } }, 404);
    return json({ error: { code: "NotFound" } }, 404);
  });
  /** A person changing a draft in Outlook: its version moves on. */
  const edit = (draftId: string) => etags.set(draftId, `W/"${draftId}-edited"`);
  return { calls, fetchMock, etags, edit };
}

export function message(
  id: string,
  from: string,
  subject: string,
  body: string,
  name = "",
  received = new Date(),
) {
  return {
    id,
    conversationId: `conv-${id}`,
    subject,
    receivedDateTime: received.toISOString(),
    from: { emailAddress: { name, address: from } },
    body: { content: body },
  };
}
