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

export type Call = { method: string; url: string; body: unknown };
type Box = { status?: number; value?: unknown[]; expiredToken?: string };

/** Answers Billie's requests to Microsoft and records them. */
export function fakeMicrosoft(inbox: Record<string, Box>) {
  const calls: Call[] = [];
  let drafts = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : null;
    calls.push({ method, url, body: raw?.startsWith("{") ? JSON.parse(raw) : raw });
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
    if (url.endsWith("/createReply")) {
      drafts++;
      return json(
        {
          id: `draft-${drafts}`,
          body: { content: '<html><body dir="ltr"><div>Original email</div></body></html>' },
        },
        201,
      );
    }
    if (method === "GET" && url.includes("$select=categories"))
      return json({ categories: ["VIP"] });
    if (method === "GET" && url.includes("$select=isDraft")) return json({ isDraft: true });
    if (method === "PATCH") return json({});
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json({ error: { code: "NotFound" } }, 404);
  });
  return { calls, fetchMock };
}

export function message(id: string, from: string, subject: string, body: string, name = "") {
  return {
    id,
    conversationId: `conv-${id}`,
    subject,
    receivedDateTime: new Date().toISOString(),
    from: { emailAddress: { name, address: from } },
    body: { content: body },
  };
}
