import { verifySlackSignature } from "@/lib/channels/slack-rules";
import { slackConfigured } from "@/lib/channels/slack";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";

/**
 * Buttons on Billie's Slack posts ("Hand back to Billie", "Close the chat").
 * Signed like every Slack request; queued once each and handled straight
 * after this answers (Slack wants an answer within three seconds).
 * "Open in Billie" buttons are plain links: their presses are only noted.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Payload = {
  type?: string;
  trigger_id?: string;
  user?: { id?: string };
  container?: { channel_id?: string; message_ts?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: { action_id?: string; value?: string; action_ts?: string }[];
};

export async function POST(request: Request) {
  if (!slackConfigured()) return new Response("Not configured", { status: 404 });
  const raw = await request.text();
  if (raw.length > 64_000) return new Response("Too large", { status: 413 });
  if (
    !verifySlackSignature(
      raw,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      process.env.SLACK_SIGNING_SECRET!.trim(),
    )
  )
    return new Response("Bad signature", { status: 401 });
  let p: Payload;
  try {
    p = JSON.parse(new URLSearchParams(raw).get("payload") ?? "");
  } catch {
    return new Response("Bad payload", { status: 400 });
  }
  const action = p.actions?.[0];
  const channel = p.container?.channel_id ?? p.channel?.id;
  const ts = p.container?.message_ts ?? p.message?.ts;
  if (
    p.type === "block_actions" &&
    action?.action_id &&
    ["billie_hand_back", "billie_close"].includes(action.action_id) &&
    UUID.test(action.value ?? "") &&
    p.user?.id &&
    channel &&
    ts
  ) {
    const id = await enqueue(
      "slack_action",
      {
        action: action.action_id,
        conversationId: action.value,
        user: p.user.id,
        channel,
        ts,
      },
      {
        dedupeKey:
          `slack-action:${channel}:${ts}:${action.action_id}:${action.action_ts ?? p.trigger_id ?? ""}`.slice(
            0,
            200,
          ),
        once: true,
      },
    );
    if (id) await kickJobs();
  }
  return new Response(null, { status: 200 });
}
