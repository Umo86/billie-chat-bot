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
  inOurWorkspace,
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
  mentionsSomeone,
  slackExternalId,
  slackFromCard,
  slackMessageOf,
  slackToPlain,
  TEAM_ONLY_LINE,
  ticketReplyLine,
  type SlackBlock,
} from "@/lib/channels/slack-rules";
import { postToTeams } from "@/lib/channels/teams";
import { enqueue } from "@/lib/jobs/queue";

/**
 * Slack for the team (docs/slack.md). Once Slack is connected, a chat that
 * needs a person is posted in the event's Slack channel with what was said
 * so far, and the team answers in that post's thread: each reply goes to
 * the visitor (in the chat, on WhatsApp, or by email for a ticket), and what
 * the visitor writes comes into the thread. Only people on Billie who work
 * on the bot can answer (matched by their Slack email, in Media10's own
 * workspace); anything starting "note:", or that @mentions someone, stays
 * with the team. Billie's other posts for a bot (email replies to check,
 * the weekly post, show-day posts, requests) go to the same channel, and
 * messages to one person become Slack direct messages. The company-wide
 * channel only gets a short alert about chats from bots without a channel.
 */

/**
 * The bot's Slack channel, or else the company-wide one (not with `ownOnly`:
 * anything with an event's details or people's contact details goes only to
 * the bot's own); none until Slack is connected.
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

/** Who they are; their email and phone only in the bot's own channel. */
function whoLine(contact: ContactDetails, opts: { reach?: boolean } = { reach: true }): string {
  return [
    contact.name,
    contact.company,
    contact.stand && `stand ${contact.stand}`,
    ...(opts.reach ? [contact.email, contact.phone] : []),
  ]
    .filter(Boolean)
    .join(", ");
}

export type SlackHandover = {
  kind: "live" | "ticket";
  botName: string;
  /** Their first question (for the short alert in the company-wide channel). */
  question: string;
  reason: string;
  contact: ContactDetails;
  routed?: { topic: string; name: string; email: string } | null;
  /** Who else should hear about a ticket (the event mailbox's manager). */
  alsoEmails?: string[];
  /** The show's Slack people (People step): @mentioned unless the topic has its own person. */
  team?: string[];
  link: string;
};

const ACTIONS = { handBack: "billie_hand_back", close: "billie_close" } as const;

const titleOf = (h: SlackHandover) =>
  h.kind === "live"
    ? `${h.botName}: someone is waiting for a person`
    : `${h.botName}: a question needs a reply`;

function handoverBlocks(
  h: SlackHandover,
  conversationId: string,
  chat: { channel: string; so: string },
  mentionIds: string[],
): { text: string; blocks: SlackBlock[] } {
  const title = titleOf(h);
  const who = whoLine(h.contact);
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
  if (chat.so) blocks.push(block.line(`The chat so far:\n${chat.so}`));
  blocks.push(
    block.note(
      h.kind === "live"
        ? `Reply in this thread to answer them: they see your first name. ${TEAM_ONLY_LINE}`
        : `${ticketReplyLine({ channel: chat.channel, email: h.contact.email }, emailConfigured())} ${TEAM_ONLY_LINE}`,
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
 * The company-wide channel's short alert, for a bot without a channel of its
 * own: what they asked and who they are, as the Teams alert had, but not how
 * to reach them or the chat, since anyone in that channel sees it, whichever
 * bots they work on. It's answered in Billie, not in its thread.
 */
function alertBlocks(
  h: SlackHandover,
  mentionIds: string[],
): { text: string; blocks: SlackBlock[] } {
  const title = titleOf(h);
  const who = whoLine(h.contact, { reach: false });
  return {
    text: title,
    blocks: [
      block.header(title),
      ...(mentionIds.length ? [block.mention(mentionIds)] : []),
      block.line(
        [
          `Question: ${h.question || "(not given)"}`,
          `Why: ${h.reason}`,
          ...(who ? [`From: ${who}`] : []),
          ...(h.routed ? [`About: ${h.routed.topic}, which ${h.routed.name} handles`] : []),
        ].join("\n"),
      ),
      block.note(
        "This bot has no Slack channel of its own, so answer it in Billie. To answer chats in Slack, choose the bot's channel on its Email step.",
      ),
      block.buttons([{ text: "Open in Billie", url: h.link }]),
    ],
  };
}

/**
 * Posts a chat that needs a person in the bot's Slack channel and remembers
 * its thread. A ticket for a chat that was already posted live (nobody
 * answered in time) goes in the same thread, shown in the channel too. A bot
 * without a channel of its own gets a short alert in the company-wide one
 * instead, with no thread to answer in. False when there's neither (Teams
 * is used instead).
 */
export async function postHandoverToSlack(
  conversationId: string,
  botId: string,
  h: SlackHandover,
): Promise<boolean> {
  // Who to @mention: whoever handles the topic, else the show's Slack people; for a live
  // chat with neither, everyone here now.
  const mentions = async () => {
    const people = await slackIds([
      ...(h.routed ? [h.routed.email] : (h.team ?? [])),
      ...(h.alsoEmails ?? []),
    ]);
    return people.length ? people : h.kind === "live" ? ["here"] : [];
  };
  const channel = await slackChannelFor(botId, { ownOnly: true });
  if (!channel) {
    const wide = await slackChannelFor(null);
    if (!wide) return false;
    const { text, blocks } = alertBlocks(h, await mentions());
    await postMessage({ channel: wide, text, blocks });
    return true;
  }
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { handoverAt: true, channel: true },
  });
  const so = await chatSoFar(conversationId);
  const mentionIds = await mentions();
  const chat = { channel: conv?.channel ?? "web" };

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
      const { text, blocks } = handoverBlocks(h, conversationId, { ...chat, so: "" }, mentionIds);
      await postMessage({ channel, text, blocks, threadTs: live.ts, broadcast: true });
      await db
        .update(slackThreads)
        .set({ kind: "ticket" })
        .where(and(eq(slackThreads.channel, live.channel), eq(slackThreads.ts, live.ts)));
      return true;
    }
  }
  const { text, blocks } = handoverBlocks(h, conversationId, { ...chat, so }, mentionIds);
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

/**
 * The person on Billie behind a Slack user (same email), if they can still
 * sign in, and only for someone in Media10's own workspace.
 */
async function actorFor(slackUserId: string): Promise<Actor | null> {
  const u = await slackUser(slackUserId);
  if (!u?.email || u.bot || !(await inOurWorkspace(u))) return null;
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
  if (!thread) return;
  // For the team, not the visitor: a note, or a message to someone in the team.
  const text = slackToPlain(e.text);
  if (!text || isTeamNote(text) || mentionsSomeone(e.text)) return;
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
  let via: "chat" | "whatsapp" | "email";
  try {
    // Kept under its Slack message, so the job running again never sends it twice.
    ({ via } = await staffReply(actor, conv.id, text, {
      fromSlack: true,
      externalId: slackExternalId(e.channel, e.ts),
    }));
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
  // A tick once it reached them: now in the chat; by WhatsApp or email once it's sent.
  if (via === "chat") await addReaction(e.channel, e.ts, "white_check_mark").catch(() => undefined);
}

/**
 * After a reply written in Slack went by WhatsApp or email (lib/conversations/
 * delivery.ts): a tick on it once sent, or a line in the thread saying why it
 * couldn't go, so whoever wrote it knows.
 */
export async function slackDelivery(
  message: { id: string; conversationId: string; externalId: string | null },
  problem: string | null,
): Promise<void> {
  const from = slackMessageOf(message.externalId);
  if (!from || !slackConfigured()) return;
  if (!problem) {
    await addReaction(from.channel, from.ts, "white_check_mark").catch(() => undefined);
    return;
  }
  await enqueue(
    "slack_note",
    {
      conversationId: message.conversationId,
      text: `That reply didn't reach them. ${problem}`,
    },
    { dedupeKey: `slack-not-sent:${message.id}`, once: true },
  );
}

export type SlackAction = {
  action: string;
  conversationId: string;
  user: string;
  channel: string;
  /** The message the button is on. */
  ts: string;
  /** Its thread, for a button on a reply (a ticket posted in a live chat's thread). */
  threadTs?: string;
};

/** The "slack_action" job: "Hand back to Billie" or "Close the chat" on a chat's post. */
export async function handleSlackAction(a: SlackAction): Promise<void> {
  if (!slackConfigured()) return;
  if (a.action !== ACTIONS.handBack && a.action !== ACTIONS.close) return;
  // Only the chat this post (or the post this reply is in the thread of) is about.
  const root = a.threadTs && a.threadTs !== a.ts ? a.threadTs : a.ts;
  const [thread] = await db
    .select()
    .from(slackThreads)
    .where(and(eq(slackThreads.channel, a.channel), eq(slackThreads.ts, root)));
  if (!thread || thread.conversationId !== a.conversationId) return;
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, a.conversationId),
    columns: { id: true, botId: true },
  });
  if (!conv) return;
  const actor = await actorFor(a.user);
  if (!actor || !can(actor, "inbox.reply") || !(await mayOnBot(actor, "inbox.reply", conv.botId))) {
    await postEphemeral({ channel: a.channel, user: a.user, text: NOT_ON_BILLIE, threadTs: root });
    return;
  }
  const { handBack, closeConversation, ChatError } = await import("@/lib/conversations/service");
  try {
    if (a.action === ACTIONS.handBack) await handBack(actor, conv.id);
    else await closeConversation(actor, conv.id);
  } catch (err) {
    if (err instanceof ChatError) {
      await postEphemeral({ channel: a.channel, user: a.user, text: err.message, threadTs: root });
      return;
    }
    throw err;
  }
  const what =
    a.action === ACTIONS.handBack
      ? `${actor.name || actor.email} handed this back to Billie.`
      : `${actor.name || actor.email} closed this chat.`;
  await markThreadDone(a.channel, root, what);
  // The ticket in its thread had the buttons too.
  if (root !== a.ts) await markThreadDone(a.channel, root, what, a.ts);
}

/** The post (or, with `ts`, the ticket in its thread), with its buttons swapped for what happened. */
async function markThreadDone(
  channel: string,
  root: string,
  what: string,
  ts = root,
): Promise<void> {
  const [thread] = await db
    .select()
    .from(slackThreads)
    .where(and(eq(slackThreads.channel, channel), eq(slackThreads.ts, root)));
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
