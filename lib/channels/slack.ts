import "server-only";
import { escapeMrkdwn, type SlackBlock } from "./slack-rules";

/**
 * Slack's Web API, with the Billie app's bot token (SLACK_BOT_TOKEN). The
 * app is made from the manifest in docs/slack.md; Slack sends events and
 * button presses to /api/webhooks/slack/*, signed with SLACK_SIGNING_SECRET.
 * A failure throws SlackError, so the job that called it retries.
 */
export function slackConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SLACK_BOT_TOKEN?.trim() && env.SLACK_SIGNING_SECRET?.trim());
}

export class SlackError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryAfter?: number,
  ) {
    super(`Slack: ${code}`);
    this.name = "SlackError";
  }
}

const PASSING = new Set([
  "rate_limited",
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

/**
 * Worth trying again later? Slack being busy or out of reach, yes; Billie
 * not in the channel, an archived channel or a revoked token, no: those
 * need someone to fix them.
 */
export function slackRetryable(err: unknown): boolean {
  if (!(err instanceof SlackError)) return true; // the network, a timeout
  return PASSING.has(err.code) || /^http_5\d\d$/.test(err.code);
}

/**
 * Slack reads a message's `text` (what notifications and previews show) as
 * its own markup, so it's escaped: nobody's words become a mention or a link.
 */
const safeText = (text: string, max = 3000) => escapeMrkdwn(text.slice(0, max));

type Params = Record<string, string | number | boolean | undefined | null | unknown[]>;

/** Slack's "write" methods take JSON; the "read" ones a form. */
async function call<T extends Record<string, unknown>>(
  method: string,
  params: Params,
  as: "json" | "form" = "json",
): Promise<T> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) throw new SlackError("not_configured");
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
  );
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type":
        as === "json" ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
    },
    body:
      as === "json"
        ? JSON.stringify(clean)
        : new URLSearchParams(
            Object.entries(clean).map(([k, v]) => [
              k,
              typeof v === "string" ? v : JSON.stringify(v),
            ]),
          ).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429)
    throw new SlackError("rate_limited", Number(res.headers.get("retry-after")) || 30);
  const json = (await res.json().catch(() => null)) as
    (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !json) throw new SlackError(`http_${res.status}`);
  if (!json.ok) throw new SlackError(String(json.error ?? "unknown_error"));
  return json;
}

export async function postMessage(m: {
  channel: string;
  text: string;
  blocks?: SlackBlock[];
  threadTs?: string;
  /** A reply in a thread that shows in the channel too. */
  broadcast?: boolean;
}): Promise<{ channel: string; ts: string }> {
  const r = await call<{ channel: string; ts: string }>("chat.postMessage", {
    channel: m.channel,
    text: safeText(m.text),
    blocks: m.blocks,
    thread_ts: m.threadTs,
    reply_broadcast: m.threadTs && m.broadcast ? true : undefined,
    // Nothing anyone wrote turns into a preview of a page.
    unfurl_links: false,
    unfurl_media: false,
  });
  return { channel: r.channel, ts: r.ts };
}

export async function updateMessage(m: {
  channel: string;
  ts: string;
  text: string;
  blocks: SlackBlock[];
}): Promise<void> {
  await call("chat.update", {
    channel: m.channel,
    ts: m.ts,
    text: safeText(m.text),
    blocks: m.blocks,
  });
}

/** A message only that person sees, in the channel (or thread) they're in. */
export async function postEphemeral(m: {
  channel: string;
  user: string;
  text: string;
  threadTs?: string;
}): Promise<void> {
  await call("chat.postEphemeral", {
    channel: m.channel,
    user: m.user,
    text: safeText(m.text),
    thread_ts: m.threadTs,
  });
}

/** A tick on a team member's reply: it reached the visitor. */
export async function addReaction(channel: string, ts: string, name: string): Promise<void> {
  await call("reactions.add", { channel, timestamp: ts, name }).catch((err) => {
    if (!(err instanceof SlackError && err.code === "already_reacted")) throw err;
  });
}

type SlackUser = {
  id: string;
  email: string;
  name: string;
  bot: boolean;
  /** Their workspace: someone in a channel shared with another company has that company's. */
  team: string;
  enterprise: string;
};
const users = new Map<string, { user: SlackUser | null; at: number }>();
const byEmail = new Map<string, { id: string | null; at: number }>();
let workspace: { value: Workspace; at: number } | null = null;
const TTL_MS = 10 * 60_000;

/** Forget the people looked up (tests; and a person's Slack email can change). */
export function clearSlackCache(): void {
  users.clear();
  byEmail.clear();
  workspace = null;
}

/** A Slack user's email and name (Billie matches people by email). */
export async function slackUser(id: string): Promise<SlackUser | null> {
  const hit = users.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.user;
  let user: SlackUser | null = null;
  try {
    const r = await call<{
      user: {
        id: string;
        team_id?: string;
        deleted?: boolean;
        is_bot?: boolean;
        real_name?: string;
        profile?: { email?: string; display_name?: string; real_name?: string };
        enterprise_user?: { enterprise_id?: string };
      };
    }>("users.info", { user: id }, "form");
    user = r.user.deleted
      ? null
      : {
          id: r.user.id,
          email: (r.user.profile?.email ?? "").trim().toLowerCase(),
          name:
            r.user.profile?.display_name ||
            r.user.profile?.real_name ||
            r.user.real_name ||
            "Someone",
          bot: Boolean(r.user.is_bot),
          team: r.user.team_id ?? "",
          enterprise: r.user.enterprise_user?.enterprise_id ?? "",
        };
  } catch (err) {
    if (!(err instanceof SlackError && err.code === "user_not_found")) throw err;
  }
  users.set(id, { user, at: Date.now() });
  return user;
}

/** The Slack user with this email, if there is one in the workspace. */
export async function slackUserIdFor(email: string): Promise<string | null> {
  const key = email.trim().toLowerCase();
  if (!key) return null;
  const hit = byEmail.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.id;
  let id: string | null = null;
  try {
    id = (await call<{ user: { id: string } }>("users.lookupByEmail", { email: key }, "form")).user
      .id;
  } catch (err) {
    if (!(err instanceof SlackError && err.code === "users_not_found")) throw err;
  }
  byEmail.set(key, { id, at: Date.now() });
  return id;
}

/** The direct-message channel between Billie and one person. */
export async function openDirect(userId: string): Promise<string> {
  return (await call<{ channel: { id: string } }>("conversations.open", { users: userId })).channel
    .id;
}

export type SlackChannel = { id: string; name: string; private: boolean };

/** Channels Billie has been added to (the only ones it can post in and read replies from). */
export async function billieChannels(): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await call<{
      channels: { id: string; name: string; is_private?: boolean; is_member?: boolean }[];
      response_metadata?: { next_cursor?: string };
    }>(
      "conversations.list",
      {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 1000,
        cursor,
      },
      "form",
    );
    for (const c of r.channels)
      if (c.is_member) out.push({ id: c.id, name: c.name, private: Boolean(c.is_private) });
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

type Workspace = { team: string; teamId: string; enterpriseId: string; botUserId: string };

/** Which workspace the token is for (its name and id), and Billie's own user there. */
export async function slackWorkspace(): Promise<Workspace> {
  if (workspace && Date.now() - workspace.at < TTL_MS) return workspace.value;
  const r = await call<{ team: string; team_id?: string; enterprise_id?: string; user_id: string }>(
    "auth.test",
    {},
    "form",
  );
  const value = {
    team: r.team,
    teamId: r.team_id ?? "",
    enterpriseId: r.enterprise_id ?? "",
    botUserId: r.user_id,
  };
  workspace = { value, at: Date.now() };
  return value;
}

/**
 * Is this Slack user one of Media10's own (its workspace, or its organisation
 * on Enterprise Grid)? Not someone from another company in a shared channel,
 * whose email that company controls.
 */
export async function inOurWorkspace(u: SlackUser): Promise<boolean> {
  const ws = await slackWorkspace();
  if (!ws.teamId) return false;
  return u.team === ws.teamId || Boolean(ws.enterpriseId && u.enterprise === ws.enterpriseId);
}
