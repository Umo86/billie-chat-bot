import { vi } from "vitest";

/**
 * A stand-in for Slack's Web API, for DB tests: fetch is swapped for this,
 * which answers Billie's calls to slack.com and records them. Nothing
 * reaches Slack. People are by Slack id, with their email, in Media10's
 * workspace (T0MEDIA10) unless `team` says another company's.
 */
export type SlackCall = { method: string; body: Record<string, unknown> };

let lastTs = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);

export function fakeSlack(
  opts: {
    people?: Record<string, { email: string; name: string; bot?: boolean; team?: string }>;
    channels?: { id: string; name: string; is_private?: boolean; is_member?: boolean }[];
    /** Methods that fail, with Slack's error code. */
    fail?: Record<string, string>;
  } = {},
) {
  const calls: SlackCall[] = [];
  /** What Slack answered each post with: its id (ts), and its thread's. */
  const posted: { channel: string; ts: string; threadTs?: string }[] = [];
  const people = opts.people ?? {};
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://slack.com/api/")) return json({ error: "not Slack" }, 404);
    const method = url.slice("https://slack.com/api/".length);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body: Record<string, unknown> = raw.startsWith("{")
      ? JSON.parse(raw)
      : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, body });
    if (opts.fail?.[method]) return json({ ok: false, error: opts.fail[method] });
    switch (method) {
      case "chat.postMessage": {
        // Slack's ids are unique in a channel: so are these, across tests.
        const ts = `${++lastTs}.000100`;
        posted.push({
          channel: String(body.channel),
          ts,
          threadTs: body.thread_ts ? String(body.thread_ts) : undefined,
        });
        return json({ ok: true, channel: body.channel, ts });
      }
      case "chat.update":
      case "chat.postEphemeral":
      case "reactions.add":
        return json({ ok: true });
      case "users.info": {
        const p = people[String(body.user)];
        return p
          ? json({
              ok: true,
              user: {
                id: body.user,
                team_id: p.team ?? "T0MEDIA10",
                is_bot: Boolean(p.bot),
                profile: { email: p.email, display_name: p.name },
              },
            })
          : json({ ok: false, error: "user_not_found" });
      }
      case "users.lookupByEmail": {
        const id = Object.keys(people).find(
          (k) => people[k].email.toLowerCase() === String(body.email).toLowerCase(),
        );
        return id
          ? json({ ok: true, user: { id } })
          : json({ ok: false, error: "users_not_found" });
      }
      case "conversations.open":
        return json({ ok: true, channel: { id: `D${String(body.users)}` } });
      case "conversations.list":
        return json({
          ok: true,
          channels: (opts.channels ?? []).map((c) => ({ is_member: true, ...c })),
          response_metadata: { next_cursor: "" },
        });
      case "auth.test":
        return json({ ok: true, team: "Media10", team_id: "T0MEDIA10", user_id: "UBILLIE" });
      default:
        return json({ ok: false, error: "unknown_method" });
    }
  });
  /** What Billie posted, by method. */
  const sent = (method: string) => calls.filter((c) => c.method === method).map((c) => c.body);
  /** All the text in a post's blocks, for checking what it says. */
  const textOf = (body: Record<string, unknown>) =>
    JSON.stringify(body.blocks ?? []) + String(body.text ?? "");
  return { calls, posted, fetchMock, sent, textOf };
}

/** A Slack request as Slack signs it (for the webhook routes). */
export { verifySlackSignature } from "@/lib/channels/slack-rules";
