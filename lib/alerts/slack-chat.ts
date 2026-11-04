import "server-only";
import { and, asc, desc, eq, gte, isNotNull, ne, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, conversations, messages, slackThreads, users } from "@/lib/db/schema";
import { appUrl, emailConfigured } from "@/lib/config";
import { getSettings } from "@/lib/settings";
import { can, type Actor } from "@/lib/authz";
import { mayOnBot } from "@/lib/auth/bots";
import type { ContactDetails } from "@/lib/types";
import {
  addReaction,
  openDirect,
  postEphemeral,
  postMessage,
  slackConfigured,
  slackUser,
  slackUserIdFor,
  updateMessage,
} from "@/lib/channels/slack";
import {
  block,
  isTeamNote,
  slackFromCard,
  slackToPlain,
  type SlackBlock,
} from "@/lib/channels/slack-rules";
import { postToTeams } from "@/lib/channels/teams";

/**
 * Slack for the team (docs/slack.md). Once Slack is connected, a chat that
 * needs a person is posted in the event's Slack channel with what was said
 * so far, and the team answers in that post's thread: each reply goes to
 * the visitor (in the chat, on WhatsApp, or by email for a ticket), and what
 * the visitor writes comes into the thread. Only people on Billie who work
 * on the bot can answer (matched by their Slack email); anything starting
 * "note:" stays with the team. Billie's other posts for a bot (email
 * replies to check, the weekly post, show-day posts, requests) go to the
 * same channel, and messages to one person become Slack direct messages.
 */

/**
 * The bot's Slack channel, or else the company-wide one (not for a bot's own
 * posts, like its weekly post, with `ownOnly`); none until Slack is connected.
 */
export async function slackChannelFor(
  botId: string | null,
  opts: { ownOnly?: boolean } = {},
): Promise<string | null> {
  if (!slackConfigured()) return null;
  const bot = botId
    ? await db.query.bots.findFirst({
        where: eq(bots.id, botId),
        columns: { slackChannelId: true },
      })
    : null;
  const own = bot?.slackChannelId?.trim();
  if (own || opts.ownOnly) return own || null;
  return (await getSettings()).slackChannelId?.trim() || null;
}

/** Has the bot a channel of its own: Slack (once connected) or Teams? */
export function hasOwnChannel(bot: {
  teamsWebhookUrl: string | null;
  slackChannelId: string | null;
}): boolean {
  return Boolean(bot.teamsWebhookUrl?.trim() || (slackConfigured() && bot.slackChannelId?.trim()));
}

/** The same, for a query over bots. */
export function ownChannelSql() {
  const teams = and(isNotNull(bots.teamsWebhookUrl), ne(bots.teamsWebhookUrl, ""))!;
  return slackConfigured()
    ? or(teams, and(isNotNull(bots.slackChannelId), ne(bots.slackChannelId, "")))!
    : teams;
}

/** Slack ids for these people, where they're in the workspace. */
async function slackIds(emails: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const e of [...new Set(emails.map((x) => x.trim().toLowerCase()).filter(Boolean))]) {
    const id = await slackUserIdFor(e).catch(() => null);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Posts one of Billie's Teams cards to the bot's team: in its Slack channel
 * once Slack is connected (and the bot or the company has a channel), else
 * to the Teams link given. `card` is a Teams message ({ attachments }) or a card.
 */
export async function postToTeam(opts: {
  botId: string | null;
  teamsLink: string | null | undefined;
  message: unknown;
  /** Its own channel only (a bot's weekly and show-day posts). */
  ownOnly?: boolean;
  /** People to @mention in Slack (Teams cards name them in the card). */
  mention?: string[];
}): Promise<"slack" | "teams" | null> {
  const channel = await slackChannelFor(opts.botId, { ownOnly: opts.ownOnly });
  if (channel) {
    const content =
      (opts.message as { attachments?: { content?: unknown }[] })?.attachments?.[0]?.content ??
      opts.message;
    const { text, blocks, mentionEmails } = slackFromCard(content);
    const ids = await slackIds([...mentionEmails, ...(opts.mention ?? [])]);
    if (ids.length) blocks.splice(1, 0, block.mention(ids));
    await postMessage({ channel, text, blocks });
    return "slack";
  }
  if (!opts.teamsLink?.trim()) return null;
  await postToTeams(opts.teamsLink.trim(), opts.message);
  return "teams";
}

/** The "slack_direct" job: one of Billie's cards to one person, as a Slack direct message. */
export async function sendSlackDirect(to: string, card: unknown): Promise<void> {
  if (!slackConfigured()) return;
  const id = await slackUserIdFor(to);
  if (!id) return; // not in the workspace
  const { text, blocks } = slackFromCard(card);
  await postMessage({ channel: await openDirect(id), text, blocks });
}

// ---------------------------------------------------------------------------
// Chats in threads

const ROLE_LABEL = { visitor: "Visitor", bot: "Billie", agent: "Team", system: "" } as const;

/** What was said so far, newest last, as plain lines that fit in one Slack block. */
async function chatSoFar(conversationId: string): Promise<string> {
  const rows = await db
    .select({ role: messages.role, text: messages.text, authorId: messages.authorId })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(12);
  const lines: string[] = [];
  let size = 0;
  for (const m of rows) {
    if (m.role === "system") continue;
    const text = m.text.replace(/\s+/g, " ").trim();
    const line = `${ROLE_LABEL[m.role]}: ${text.length > 300 ? `${text.slice(0, 299)}…` : text}`;
    if (size + line.length > 2600) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

function whoLine(contact: ContactDetails): string {
  return [
    contact.name,
    contact.company,
    contact.stand && `stand ${contact.stand}`,
    contact.email,
    contact.phone,
  ]
    .filter(Boolean)
    .join(", ");
}

export type SlackHandover = {
  kind: "live" | "ticket";
  botName: string;
  reason: string;
  contact: ContactDetails;
  routed?: { topic: string; name: string; email: string } | null;
  /** Who else should hear about a ticket (the event mailbox's manager). */
  alsoEmails?: string[];
  link: string;
};

const ACTIONS = { handBack: "billie_hand_back", close: "billie_close" } as const;

function handoverBlocks(
  h: SlackHandover,
  conversationId: string,
  so: string,
  mentionIds: string[],
): { text: string; blocks: SlackBlock[] } {
  const title =
    h.kind === "live"
      ? `${h.botName}: someone is waiting for a person`
      : `${h.botName}: a question needs a reply`;
  const who = whoLine(h.contact);
  const canEmail = emailConfigured() && Boolean(h.contact.email);
  const blocks: SlackBlock[] = [block.header(title)];
  if (mentionIds.length)
    blocks.push(block.mention(mentionIds, h.kind === "live" ? "can you take this?" : ""));
  blocks.push(
    block.line(
      [
        `Why: ${h.reason}`,
        ...(who ? [`From: ${who}`] : []),
        ...(h.routed ? [`About: ${h.routed.topic}, which ${h.routed.name} handles`] : []),
      ].join("\n"),
    ),
  );
  if (so) blocks.push(block.line(`The chat so far:\n${so}`));
  blocks.push(
    block.note(
      h.kind === "live"
        ? "Reply in this thread to answer them: they see your first name. Start a message with “note:” to keep it to the team."
        : canEmail
          ? "Reply in this thread: it goes to them by email. Start a message with “note:” to keep it to the team."
          : "Billie can't email them a reply yet (email sending isn't set up), so contact them yourself.",
    ),
  );
  blocks.push(
    block.buttons([
      ...(h.kind === "live"
        ? [{ text: "Hand back to Billie", actionId: ACTIONS.handBack, value: conversationId }]
        : []),
      {
        text: "Close the chat",
        actionId: ACTIONS.close,
        value: conversationId,
        style: "danger" as const,
      },
      { text: "Open in Billie", url: h.link },
    ]),
  );
  return { text: title, blocks };
}

/**
 * Posts a chat that needs a person in the bot's Slack channel and remembers
 * its thread. A ticket for a chat that was already posted live (nobody
 * answered in time) goes in the same thread, shown in the channel too.
 * False when the bot has no Slack channel (Teams is used instead).
 */
export async function postHandoverToSlack(
  conversationId: string,
  botId: string,
  h: SlackHandover,
): Promise<boolean> {
  const channel = await slackChannelFor(botId);
  if (!channel) return false;
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { handoverAt: true },
  });
  const so = await chatSoFar(conversationId);
  // Who to @mention: whoever handles the topic; for a live chat, else everyone here now.
  const people = await slackIds([...(h.routed ? [h.routed.email] : []), ...(h.alsoEmails ?? [])]);
  const mentionIds = people.length ? people : h.kind === "live" ? ["here"] : [];

  if (h.kind === "ticket" && conv?.handoverAt) {
    const [live] = await db
      .select()
      .from(slackThreads)
      .where(
        and(
          eq(slackThreads.conversationId, conversationId),
          eq(slackThreads.channel, channel),
          gte(slackThreads.createdAt, conv.handoverAt),
        ),
      )
      .orderBy(desc(slackThreads.createdAt))
      .limit(1);
    if (live) {
      const { text, blocks } = handoverBlocks(h, conversationId, "", mentionIds);
      await postMessage({ channel, text, blocks, threadTs: live.ts });
      await db
        .update(slackThreads)
        .set({ kind: "ticket" })
        .where(and(eq(slackThreads.channel, live.channel), eq(slackThreads.ts, live.ts)));
      return true;
    }
  }
  const { text, blocks } = handoverBlocks(h, conversationId, so, mentionIds);
  const posted = await postMessage({ channel, text, blocks });
  await db
    .insert(slackThreads)
    .values({ channel: posted.channel, ts: posted.ts, conversationId, kind: h.kind })
    .onConflictDoNothing();
  return true;
}

/** The chat's latest thread, if it has one. */
async function latestThread(conversationId: string) {
  const [t] = await db
    .select()
    .from(slackThreads)
    .where(eq(slackThreads.conversationId, conversationId))
    .orderBy(desc(slackThreads.createdAt))
    .limit(1);
  return t ?? null;
}

/** The "slack_relay" job: a message in the chat (the visitor's, or a reply from the Inbox) into its thread. */
export async function relayToSlack(messageId: string): Promise<void> {
  if (!slackConfigured()) return;
  const m = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!m) return;
  const thread = await latestThread(m.conversationId);
  if (!thread || thread.createdAt > m.createdAt) return;
  let who = "Visitor";
  if (m.role === "agent") {
    const u = m.authorId
      ? await db.query.users.findFirst({
          where: eq(users.id, m.authorId),
          columns: { fullName: true },
        })
      : null;
    who = `${u?.fullName || "The team"} (in Billie)`;
  } else if (m.role !== "visitor") return;
  const text = `${who}: ${m.text}`;
  await postMessage({
    channel: thread.channel,
    text,
    blocks: [block.line(text)],
    threadTs: thread.ts,
  });
}

/** The "slack_note" job: a line from Billie in the chat's thread. */
export async function noteInSlack(conversationId: string, text: string): Promise<void> {
  if (!slackConfigured()) return;
  const thread = await latestThread(conversationId);
  if (!thread) return;
  await postMessage({
    channel: thread.channel,
    text,
    blocks: [block.note(text)],
    threadTs: thread.ts,
  });
}

/** The person on Billie behind a Slack user (same email), if they can still sign in. */
async function actorFor(slackUserId: string): Promise<Actor | null> {
  const u = await slackUser(slackUserId);
  if (!u?.email || u.bot) return null;
  const row = await db.query.users.findFirst({
    where: and(eq(users.email, u.email), eq(users.status, "active")),
  });
  return row
    ? { id: row.id, email: row.email, name: row.fullName, role: row.role, status: row.status }
    : null;
}

const NOT_ON_BILLIE =
  "Only people on Billie who work on this bot can answer here. Ask an admin to add you, with the same email as your Slack account.";

export type ThreadReply = {
  channel: string;
  threadTs: string;
  ts: string;
  user: string;
  text: string;
};

/** The "slack_event" job: someone answered in a chat's thread. */
export async function handleThreadReply(e: ThreadReply): Promise<void> {
  if (!slackConfigured()) return;
  const [thread] = await db
    .select()
    .from(slackThreads)
    .where(and(eq(slackThreads.channel, e.channel), eq(slackThreads.ts, e.threadTs)));
  if (!thread || isTeamNote(e.text)) return;
  const text = slackToPlain(e.text);
  if (!text) return;
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, thread.conversationId),
    columns: { id: true, botId: true },
  });
  if (!conv) return;
  const actor = await actorFor(e.user);
  if (!actor || !can(actor, "inbox.reply") || !(await mayOnBot(actor, "inbox.reply", conv.botId))) {
    await postEphemeral({
      channel: e.channel,
      user: e.user,
      text: NOT_ON_BILLIE,
      threadTs: e.threadTs,
    });
    return;
  }
  const { staffReply, ChatError } = await import("@/lib/conversations/service");
  try {
    await staffReply(actor, conv.id, text, { fromSlack: true });
  } catch (err) {
    if (err instanceof ChatError) {
      await postEphemeral({
        channel: e.channel,
        user: e.user,
        text: `That didn't go to them: ${err.message} Open the chat in Billie: ${appUrl()}/inbox?c=${conv.id}`,
        threadTs: e.threadTs,
      });
      return;
    }
    throw err;
  }
  // A tick: it reached them.
  await addReaction(e.channel, e.ts, "white_check_mark").catch(() => undefined);
}

export type SlackAction = {
  action: string;
  conversationId: string;
  user: string;
  channel: string;
  ts: string;
};

/** The "slack_action" job: "Hand back to Billie" or "Close the chat" on a chat's post. */
export async function handleSlackAction(a: SlackAction): Promise<void> {
  if (!slackConfigured()) return;
  if (a.action !== ACTIONS.handBack && a.action !== ACTIONS.close) return;
  // Only the chat this post is about.
  const [thread] = await db
    .select()
    .from(slackThreads)
    .where(and(eq(slackThreads.channel, a.channel), eq(slackThreads.ts, a.ts)));
  if (!thread || thread.conversationId !== a.conversationId) return;
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, a.conversationId),
    columns: { id: true, botId: true },
  });
  if (!conv) return;
  const actor = await actorFor(a.user);
  if (!actor || !can(actor, "inbox.reply") || !(await mayOnBot(actor, "inbox.reply", conv.botId))) {
    await postEphemeral({ channel: a.channel, user: a.user, text: NOT_ON_BILLIE, threadTs: a.ts });
    return;
  }
  const { handBack, closeConversation, ChatError } = await import("@/lib/conversations/service");
  try {
    if (a.action === ACTIONS.handBack) await handBack(actor, conv.id);
    else await closeConversation(actor, conv.id);
  } catch (err) {
    if (err instanceof ChatError) {
      await postEphemeral({ channel: a.channel, user: a.user, text: err.message, threadTs: a.ts });
      return;
    }
    throw err;
  }
  await markThreadDone(
    a.channel,
    a.ts,
    a.action === ACTIONS.handBack
      ? `${actor.name || actor.email} handed this back to Billie.`
      : `${actor.name || actor.email} closed this chat.`,
  );
}

/** The post, with its buttons swapped for what happened. */
async function markThreadDone(channel: string, ts: string, what: string): Promise<void> {
  const [thread] = await db
    .select()
    .from(slackThreads)
    .where(and(eq(slackThreads.channel, channel), eq(slackThreads.ts, ts)));
  if (!thread) return;
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, thread.conversationId),
  });
  const bot = conv
    ? await db.query.bots.findFirst({ where: eq(bots.id, conv.botId), columns: { name: true } })
    : null;
  if (!conv || !bot) return;
  const title = `${bot.name}: ${thread.kind === "live" ? "a chat" : "a question"} the team has handled`;
  const who = whoLine(conv.contact as ContactDetails);
  await updateMessage({
    channel,
    ts,
    text: title,
    blocks: [
      block.header(title),
      block.line(
        [
          `First question: ${conv.firstQuestion || "(none)"}`,
          ...(who ? [`From: ${who}`] : []),
        ].join("\n"),
      ),
      block.note(what),
      block.buttons([{ text: "Open in Billie", url: `${appUrl()}/inbox?c=${conv.id}` }]),
    ],
  });
}

/** Chats in a thread, oldest first: for tests and the Inbox. */
export async function threadsOf(conversationId: string) {
  return db
    .select()
    .from(slackThreads)
    .where(eq(slackThreads.conversationId, conversationId))
    .orderBy(asc(slackThreads.createdAt));
}
