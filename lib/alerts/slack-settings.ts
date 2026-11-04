import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, settings } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import type { Actor } from "@/lib/authz";
import {
  billieChannels,
  postMessage,
  SlackError,
  slackConfigured,
  slackWorkspace,
  type SlackChannel,
} from "@/lib/channels/slack";
import { block, CHANNEL_ID } from "@/lib/channels/slack-rules";
import { slackChannelFor } from "./slack-chat";

/**
 * Which Slack channel a bot (or, without a bot, the company) posts to. Only
 * channels Billie has been added to can be chosen: those are the ones it
 * can post in and read replies from. Admins only, like Teams links.
 */

export type SlackStatus =
  | { connected: false }
  | { connected: true; team: string; channels: SlackChannel[]; problem: string | null };

let cached: { at: number; status: SlackStatus } | null = null;
const CACHE_MS = 20_000;

/** What the screens show: the workspace and the channels Billie is in (asked at most every 20 seconds). */
export async function slackStatus(): Promise<SlackStatus> {
  if (!slackConfigured()) return { connected: false };
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  const status = await askSlack();
  cached = status.connected && !status.problem ? { at: Date.now(), status } : null;
  return status;
}

async function askSlack(): Promise<SlackStatus> {
  try {
    const [{ team }, channels] = await Promise.all([slackWorkspace(), billieChannels()]);
    return { connected: true, team, channels, problem: null };
  } catch (err) {
    const code = err instanceof SlackError ? err.code : "unreachable";
    return {
      connected: true,
      team: "",
      channels: [],
      problem:
        code === "invalid_auth" || code === "not_authed" || code === "account_inactive"
          ? "Slack didn't accept SLACK_BOT_TOKEN. Copy the Bot User OAuth Token again from the app's OAuth & Permissions page."
          : code === "missing_scope"
            ? "The Slack app is missing a permission. Make it again from the manifest below, then reinstall it."
            : `Billie couldn't reach Slack just now (${code}). Try again in a minute.`,
    };
  }
}

export async function setSlackChannel(
  actor: Actor,
  botId: string | null,
  channelId: string | null,
): Promise<string | null> {
  if (!slackConfigured()) throw new UserError("Connect Slack first (Settings → Connections).");
  let name: string | null = null;
  if (channelId) {
    if (!CHANNEL_ID.test(channelId)) throw new UserError("Choose one of the channels in the list.");
    const found = (await billieChannels()).find((c) => c.id === channelId);
    if (!found)
      throw new UserError(
        "Billie isn't in that channel any more. Add it in Slack (/invite @Billie), then choose it again.",
      );
    name = found.name;
  }
  cached = null;
  await getSettings(); // makes sure the settings row exists
  await db.transaction(async (tx) => {
    if (botId) await tx.update(bots).set({ slackChannelId: channelId }).where(eq(bots.id, botId));
    else
      await tx.update(settings).set({ slackChannelId: channelId }).where(eq(settings.id, "main"));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: botId ? "bot" : "settings",
      entityId: botId,
      action: botId ? "update" : "settings_change",
      summary: name
        ? `Set the ${botId ? "bot's" : "company-wide"} Slack channel to #${name}`
        : `Removed the ${botId ? "bot's" : "company-wide"} Slack channel`,
    });
  });
  return name;
}

/** A test post in the channel the bot (or the company) uses now. */
export async function testSlackChannel(
  botId: string | null,
  botName: string | null,
): Promise<void> {
  const channel = await slackChannelFor(botId);
  if (!channel) throw new UserError("Choose a Slack channel first.");
  const text = botName
    ? `Billie is set up to post here for ${botName}: chats that need a person, and email replies to check.`
    : "Billie is set up to post here for bots without a channel of their own.";
  try {
    await postMessage({ channel, text, blocks: [block.line(text)] });
  } catch (err) {
    if (
      err instanceof SlackError &&
      (err.code === "not_in_channel" || err.code === "channel_not_found")
    )
      throw new UserError(
        "Billie isn't in that channel. Add it in Slack (/invite @Billie), then try again.",
      );
    throw err;
  }
}
