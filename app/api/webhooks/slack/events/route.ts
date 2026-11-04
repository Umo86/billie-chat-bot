import { verifySlackSignature } from "@/lib/channels/slack-rules";
import { slackConfigured } from "@/lib/channels/slack";

/**
 * Slack's Events API (docs/slack.md): replies in the threads of Billie's
 * posts. Every request is signed with the app's signing secret and checked
 * before anything is read from it. Each reply is queued once (Slack sends
 * again if it hasn't heard back within three seconds) and handled straight
 * after this answers. Slack's one-off address check, made while the app is
 * being created, is answered before anything else is loaded.
 */
export const dynamic = "force-dynamic";

type Message = {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
};

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 256_000) return new Response("Too large", { status: 413 });
  let payload: { type?: string; challenge?: string; event_id?: string; event?: Message };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const secret = process.env.SLACK_SIGNING_SECRET?.trim() ?? "";
  const signed = verifySlackSignature(
    raw,
    request.headers.get("x-slack-request-timestamp"),
    request.headers.get("x-slack-signature"),
    secret,
  );
  // Slack checks the address once, while the app is being made: before its
  // signing secret can be in Vercel. Answering that check changes nothing.
  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    if (secret && !signed) return new Response("Bad signature", { status: 401 });
    return Response.json({ challenge: payload.challenge.slice(0, 200) });
  }
  if (!slackConfigured()) return new Response("Not configured", { status: 404 });
  if (!signed) return new Response("Bad signature", { status: 401 });

  const e = payload.event;
  // Only people's replies in a thread (also those sent to the channel too): not Billie's
  // own posts, edits, files or joins.
  if (
    payload.type === "event_callback" &&
    e?.type === "message" &&
    (!e.subtype || e.subtype === "thread_broadcast") &&
    !e.bot_id &&
    e.user &&
    e.channel &&
    e.ts &&
    e.thread_ts &&
    e.thread_ts !== e.ts &&
    typeof e.text === "string" &&
    payload.event_id
  ) {
    // Loaded only for an event: Slack's address check (above) answers fast, even from cold.
    const [{ enqueue }, { kickJobs }] = await Promise.all([
      import("@/lib/jobs/queue"),
      import("@/lib/jobs/kick"),
    ]);
    const id = await enqueue(
      "slack_event",
      {
        channel: e.channel,
        threadTs: e.thread_ts,
        ts: e.ts,
        user: e.user,
        text: e.text.slice(0, 8000),
      },
      { dedupeKey: `slack-event:${String(payload.event_id).slice(0, 100)}`, once: true },
    );
    if (id) await kickJobs();
  }
  return new Response(null, { status: 200 });
}
