import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  botMailboxes,
  bots,
  conversations,
  emailThreads,
  jobs,
  messages,
  settings,
  slackThreads,
} from "@/lib/db/schema";
import { botById } from "@/lib/bots/load";
import { defaultRules } from "@/lib/bots/defaults";
import {
  expireWaiting,
  handover,
  startConversation,
  submitDetails,
  visitorMessage,
} from "@/lib/conversations/service";
import { notifyHandover } from "@/lib/alerts/notify";
import {
  handleSlackAction,
  handleThreadReply,
  noteInSlack,
  postToTeam,
  relayToSlack,
  sendSlackDirect,
} from "@/lib/alerts/slack-chat";
import { queueDirect } from "@/lib/alerts/direct";
import { postEmailDigest } from "@/lib/emails/slack-digest";
import { setSlackChannel, slackStatus } from "@/lib/alerts/slack-settings";
import { adaptiveMessage, plainLine } from "@/lib/alerts/card";
import { clearSlackCache } from "@/lib/channels/slack";
import { WAITED_LINE } from "@/lib/conversations/handover";
import { fakeSlack } from "../helpers/slack";
import { POST as events } from "@/app/api/webhooks/slack/events/route";
import { POST as interactions } from "@/app/api/webhooks/slack/interactions/route";
import { hasDb, makeBot, makeUser, putOnBot } from "../helpers/db";

vi.mock("@/lib/jobs/kick", () => ({ kickJobs: async () => undefined }));

const ALWAYS = { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" };
const NEVER = { days: [] as number[], start: "09:00", end: "17:00" };
const CHANNEL = "C0EVENT001";

beforeAll(() => {
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-not-real");
  vi.stubEnv("SLACK_SIGNING_SECRET", "test-signing-secret");
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => clearSlackCache());
afterEach(() => vi.unstubAllGlobals());

/** An exhibitor bot posting to an event channel in Slack, with its team hours. */
async function slackBot(hours = ALWAYS) {
  const { bot } = await makeBot();
  await db
    .update(bots)
    .set({ slackChannelId: CHANNEL, rules: { ...defaultRules("exhibitors"), hours } })
    .where(eq(bots.id, bot.id));
  return (await botById(bot.id))!;
}

async function queued(kind: string, conversationOrMessageId: string) {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, kind as never)))
    .then((rows) =>
      rows.filter((j) => JSON.stringify(j.payload).includes(conversationOrMessageId)),
    );
}

describe.skipIf(!hasDb)("chats that need a person, in Slack", () => {
  it("posts the chat so far in the event's channel; the team answers in its thread", async () => {
    const admin = await makeUser("admin");
    const agent = await makeUser("agent");
    const outsider = await makeUser("agent"); // on Billie, but not on this bot
    const slack = fakeSlack({
      people: {
        UADMIN: { email: admin.email, name: "Umit" },
        UAGENT: { email: agent.email, name: "Priya" },
        UOUT: { email: outsider.email, name: "Kim" },
        USTRANGER: { email: "stranger@elsewhere.test", name: "Stranger" },
      },
    });
    vi.stubGlobal("fetch", slack.fetchMock);
    const bot = await slackBot();
    await putOnBot(bot.id, agent.id);
    const { conversation } = await startConversation({ bot, channel: "web" });
    await visitorMessage({ bot, conversation, channel: "web", text: "When does build-up start?" });
    const turn = await handover(bot, conversation.id, "asked_for_person");
    expect(turn.status).toBe("waiting");
    await notifyHandover(conversation.id, "live");

    const [root] = slack.sent("chat.postMessage");
    expect(root.channel).toBe(CHANNEL);
    const text = slack.textOf(root);
    expect(text).toContain("Exhibitor Help: someone is waiting for a person");
    expect(text).toContain("<!here>");
    expect(text).toContain("Why: Asked for a person");
    expect(text).toContain("Visitor: When does build-up start?");
    expect(text).toContain("billie_hand_back");
    expect(text).toContain("billie_close");
    const [thread] = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, conversation.id));
    expect(thread).toMatchObject({ channel: CHANNEL, kind: "live" });
    // A retry of the job doesn't post again.
    await notifyHandover(conversation.id, "live");
    expect(slack.sent("chat.postMessage")).toHaveLength(1);

    // What the visitor writes now goes into the thread.
    const fresh = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    const next = await visitorMessage({
      bot,
      conversation: fresh!,
      channel: "web",
      text: "It's about our electrics",
    });
    const visitorRow = next.messages[0];
    expect(await queued("slack_relay", visitorRow.id)).toHaveLength(1);
    await relayToSlack(visitorRow.id);
    expect(slack.sent("chat.postMessage").at(-1)).toMatchObject({
      channel: CHANNEL,
      thread_ts: thread.ts,
      text: "Visitor: It's about our electrics",
    });

    // Someone not on Billie, or not on this bot, can't answer them.
    for (const user of ["USTRANGER", "UOUT"]) {
      await handleThreadReply({
        channel: CHANNEL,
        threadTs: thread.ts,
        ts: `${Date.now()}.1`,
        user,
        text: "Hello!",
      });
      expect(slack.sent("chat.postEphemeral").at(-1)).toMatchObject({
        user,
        text: expect.stringContaining("Only people on Billie who work on this bot"),
      });
    }
    // A note stays with the team.
    await handleThreadReply({
      channel: CHANNEL,
      threadTs: thread.ts,
      ts: "1.2",
      user: "UAGENT",
      text: "note: checking with the electrics contractor",
    });
    // Priya answers: it reaches the chat, with her first name, and gets a tick.
    await handleThreadReply({
      channel: CHANNEL,
      threadTs: thread.ts,
      ts: "1.3",
      user: "UAGENT",
      text: "Hi <@UADMIN>, the form is <https://manual.test/electrics|here> &amp; due Friday.",
    });
    const rows = await db
      .select({ role: messages.role, text: messages.text, authorId: messages.authorId })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    const agentRows = rows.filter((r) => r.role === "agent");
    expect(agentRows).toEqual([
      {
        role: "agent",
        text: "Hi , the form is here (https://manual.test/electrics) & due Friday.",
        authorId: agent.id,
      },
    ]);
    expect(rows.some((r) => r.text.includes("checking with the electrics"))).toBe(false);
    expect(slack.sent("reactions.add").at(-1)).toMatchObject({ timestamp: "1.3" });
    const live = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(live?.status).toBe("live");
    // Written in Slack: not posted back into Slack.
    expect(await queued("slack_relay", conversation.id)).toHaveLength(0);

    // "Hand back to Billie": the chat goes back, and the post says who did it.
    await handleSlackAction({
      action: "billie_hand_back",
      conversationId: conversation.id,
      user: "UAGENT",
      channel: CHANNEL,
      ts: thread.ts,
    });
    const back = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(back?.status).toBe("bot");
    const [update] = slack.sent("chat.update");
    expect(update).toMatchObject({ channel: CHANNEL, ts: thread.ts });
    expect(slack.textOf(update)).toContain("handed this back to Billie");
    expect(slack.textOf(update)).not.toContain("billie_hand_back");
    // A button for another chat, on this post, does nothing.
    await handleSlackAction({
      action: "billie_close",
      conversationId: randomUUID(),
      user: "UAGENT",
      channel: CHANNEL,
      ts: thread.ts,
    });
    expect(slack.sent("chat.update")).toHaveLength(1);
  });

  it("outside working hours takes details, and posts the ticket", async () => {
    vi.stubGlobal("fetch", fakeSlack().fetchMock);
    const slack = fakeSlack();
    vi.stubGlobal("fetch", slack.fetchMock);
    const bot = await slackBot(NEVER);
    const { conversation } = await startConversation({ bot, channel: "web" });
    const turn = await handover(bot, conversation.id, "asked_for_person");
    // An exhibitor bot asks for their name, email and stand.
    expect(turn.status).toBe("collecting");
    expect(turn.form?.fields).toEqual(["name", "email", "stand"]);
    await submitDetails(bot, conversation.id, {
      name: "Sam Patel",
      email: "sam@acme.test",
      stand: "B12",
    });
    await notifyHandover(conversation.id, "ticket");
    const [post] = slack.sent("chat.postMessage");
    const text = slack.textOf(post);
    expect(text).toContain("Exhibitor Help: a question needs a reply");
    expect(text).toContain("From: Sam Patel, stand B12, sam@acme.test");
    expect(text).not.toContain("<!here>");
    expect(text).not.toContain("billie_hand_back");

    // A visitor bot asks for a phone number instead, to call them back.
    expect(defaultRules("visitors").collect).toEqual(["name", "email", "phone"]);
  });

  it("makes a ticket straight away for an exhibitor signed in from the manual", async () => {
    const slack = fakeSlack();
    vi.stubGlobal("fetch", slack.fetchMock);
    const bot = await slackBot(NEVER);
    const { conversation } = await startConversation({ bot, channel: "web" });
    await db
      .update(conversations)
      .set({ contact: { name: "Sam Patel", email: "sam@acme.test", stand: "B12" } })
      .where(eq(conversations.id, conversation.id));
    const turn = await handover(bot, conversation.id, "asked_for_person");
    expect(turn.status).toBe("ticket");
    expect(turn.form).toBeNull();
    expect(turn.messages[0].text).toBe(
      "Nobody from the team is online right now. They'll reply by email at sam@acme.test by the next working day.",
    );
    expect(await queued("notify_handover", conversation.id)).toHaveLength(1);
  });

  it("asks for details when nobody answers a live chat in five minutes", async () => {
    const slack = fakeSlack();
    vi.stubGlobal("fetch", slack.fetchMock);
    const bot = await slackBot();
    const { conversation } = await startConversation({ bot, channel: "web" });
    const at = new Date();
    await handover(bot, conversation.id, "asked_for_person", at);
    await notifyHandover(conversation.id, "live");
    // Four minutes on: still waiting.
    expect(await expireWaiting(new Date(at.getTime() + 4 * 60_000))).toBe(0);
    expect(await expireWaiting(new Date(at.getTime() + 6 * 60_000))).toBeGreaterThanOrEqual(1);
    const c = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(c?.status).toBe("collecting");
    const last = await db
      .select({ text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(last.at(-1)?.text).toBe(WAITED_LINE);
    // The thread hears about it; their details, once left, go in the same thread.
    const [note] = await queued("slack_note", conversation.id);
    await noteInSlack(conversation.id, String((note.payload as { text: string }).text));
    const [thread] = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, conversation.id));
    expect(slack.sent("chat.postMessage").at(-1)).toMatchObject({
      thread_ts: thread.ts,
      text: expect.stringContaining("Nobody answered within 5 minutes"),
    });
    await submitDetails(bot, conversation.id, { name: "Jo", email: "jo@bolt.test", stand: "C4" });
    await notifyHandover(conversation.id, "ticket");
    expect(slack.sent("chat.postMessage").at(-1)).toMatchObject({ thread_ts: thread.ts });
    const threads = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, conversation.id));
    expect(threads).toHaveLength(1);
    expect(threads[0].kind).toBe("ticket");
  });
});

describe.skipIf(!hasDb)("email replies to check, in Slack", () => {
  it("lists what Billie prepared in one post, naming the mailbox's manager, once each", async () => {
    const manager = await makeUser("editor");
    const slack = fakeSlack({ people: { UMAN: { email: manager.email, name: "Sam" } } });
    vi.stubGlobal("fetch", slack.fetchMock);
    const bot = await slackBot();
    const address = `ukcw-${randomUUID().slice(0, 6)}@media-ten.test`;
    await db.insert(botMailboxes).values({ botId: bot.id, address, assignedUserId: manager.id });
    const add = (subject: string, status: "draft_ready" | "needs_you") =>
      db.insert(emailThreads).values({
        source: "outlook",
        mailbox: address,
        botId: bot.id,
        fromName: "Jo Bloggs",
        fromEmail: "jo@bolt.test",
        subject,
        status,
        summary: "Asks about electrics",
        needsYouReason: status === "needs_you" ? "Refunds always go to a person" : null,
        outlookDraftId: status === "draft_ready" ? "draft-1" : null,
      });
    await add("Electrics order", "draft_ready");
    await add("Refund please", "needs_you");
    await postEmailDigest(bot.id);
    const posts = slack.sent("chat.postMessage");
    expect(posts).toHaveLength(1);
    const text = slack.textOf(posts[0]);
    expect(text).toContain("Exhibitor Help: email replies to check");
    expect(text).toContain(`I've prepared 1 reply in ${address}. Please review and send it.`);
    expect(text).toContain("1 email needs a person");
    expect(text).toContain("<@UMAN>");
    expect(text).toContain("Electrics order");
    expect(text).toContain("Draft ready in Outlook");
    expect(text).toContain("Needs you: Refunds always go to a person");
    // Once only.
    await postEmailDigest(bot.id);
    expect(slack.sent("chat.postMessage")).toHaveLength(1);
  });
});

describe.skipIf(!hasDb)("Billie's other posts, once Slack is connected", () => {
  it("posts its cards in the bot's channel, and messages people directly", async () => {
    const person = await makeUser("editor");
    const slack = fakeSlack({ people: { UPER: { email: person.email, name: "Jo" } } });
    vi.stubGlobal("fetch", slack.fetchMock);
    const bot = await slackBot();
    const card = adaptiveMessage({
      body: [plainLine("Exhibitor Help: last week", { bold: true, size: "Medium" })],
      actions: [{ type: "Action.OpenUrl", title: "Open Reports", url: "https://billie.test/r" }],
    });
    expect(
      await postToTeam({ botId: bot.id, teamsLink: null, message: card, mention: [person.email] }),
    ).toBe("slack");
    const [post] = slack.sent("chat.postMessage");
    expect(post.channel).toBe(CHANNEL);
    expect(slack.textOf(post)).toContain("<@UPER>");
    expect(slack.textOf(post)).toContain("Open Reports");

    // To one person: a Slack direct message, queued once.
    const key = `test:${randomUUID()}`;
    expect(await queueDirect([{ email: person.email }], key, card.attachments[0].content)).toBe(1);
    expect(await queueDirect([{ email: person.email }], key, card.attachments[0].content)).toBe(0);
    await sendSlackDirect(person.email, card.attachments[0].content);
    expect(slack.sent("conversations.open").at(-1)).toMatchObject({ users: "UPER" });
    expect(slack.sent("chat.postMessage").at(-1)).toMatchObject({ channel: "DUPER" });
    // Someone not in the workspace: nothing.
    await sendSlackDirect("nobody@elsewhere.test", card.attachments[0].content);
    expect(slack.sent("chat.postMessage")).toHaveLength(2);
  });

  it("lets admins choose only channels Billie is in", async () => {
    const admin = await makeUser("admin");
    const slack = fakeSlack({
      channels: [
        { id: "C0EVENT001", name: "ukcw-billie" },
        { id: "C0OTHER001", name: "random", is_member: false },
      ],
    });
    vi.stubGlobal("fetch", slack.fetchMock);
    const status = await slackStatus();
    expect(status).toMatchObject({ connected: true, team: "Media10", problem: null });
    expect(status.connected && status.channels.map((c) => c.name)).toEqual(["ukcw-billie"]);
    const { bot } = await makeBot();
    expect(await setSlackChannel(admin, bot.id, "C0EVENT001")).toBe("ukcw-billie");
    await expect(setSlackChannel(admin, bot.id, "C0OTHER001")).rejects.toThrow(
      /Billie isn't in that channel/,
    );
    expect(await setSlackChannel(admin, null, "C0EVENT001")).toBe("ukcw-billie");
    const s = await db.query.settings.findFirst({ where: eq(settings.id, "main") });
    expect(s?.slackChannelId).toBe("C0EVENT001");
    await setSlackChannel(admin, null, null);
  });
});

describe.skipIf(!hasDb)("Slack's requests to Billie", () => {
  const url = "https://billie.test/api/webhooks/slack";
  const signed = (
    body: string,
    ts = Math.floor(Date.now() / 1000),
    secret = "test-signing-secret",
  ) => ({
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`,
  });
  const byKey = (key: string) => db.select().from(jobs).where(eq(jobs.dedupeKey, key));

  it("answers Slack's address check, and queues each signed reply in a thread once", async () => {
    const check = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const ok = await events(
      new Request(`${url}/events`, { method: "POST", body: check, headers: signed(check) }),
    );
    expect(await ok.json()).toEqual({ challenge: "abc123" });
    const forged = await events(
      new Request(`${url}/events`, {
        method: "POST",
        body: check,
        headers: signed(check, undefined, "guess"),
      }),
    );
    expect(forged.status).toBe(401);

    const id = `Ev${randomUUID().slice(0, 8)}`;
    const reply = JSON.stringify({
      type: "event_callback",
      event_id: id,
      event: {
        type: "message",
        user: "U1",
        text: "On it",
        channel: CHANNEL,
        ts: "2.2",
        thread_ts: "1.1",
      },
    });
    expect(
      (
        await events(
          new Request(`${url}/events`, { method: "POST", body: reply, headers: signed(reply) }),
        )
      ).status,
    ).toBe(200);
    // Slack sends it again when it hasn't heard back: queued once.
    await events(
      new Request(`${url}/events`, { method: "POST", body: reply, headers: signed(reply) }),
    );
    expect(await byKey(`slack-event:${id}`)).toHaveLength(1);
    // An old request sent again, Billie's own posts, and messages outside a thread: nothing.
    const old = Math.floor(Date.now() / 1000) - 600;
    expect(
      (
        await events(
          new Request(`${url}/events`, {
            method: "POST",
            body: reply,
            headers: signed(reply, old),
          }),
        )
      ).status,
    ).toBe(401);
    for (const event of [
      {
        type: "message",
        bot_id: "B1",
        text: "Billie",
        channel: CHANNEL,
        ts: "3.3",
        thread_ts: "1.1",
      },
      { type: "message", user: "U1", text: "Top level", channel: CHANNEL, ts: "4.4" },
      {
        type: "message",
        subtype: "message_changed",
        channel: CHANNEL,
        ts: "5.5",
        thread_ts: "1.1",
      },
    ]) {
      const other = `Ev${randomUUID().slice(0, 8)}`;
      const body = JSON.stringify({ type: "event_callback", event_id: other, event });
      await events(new Request(`${url}/events`, { method: "POST", body, headers: signed(body) }));
      expect(await byKey(`slack-event:${other}`)).toHaveLength(0);
    }
  });

  it("queues signed button presses for Billie's own buttons only", async () => {
    const conversationId = randomUUID();
    const press = (actionId: string) =>
      `payload=${encodeURIComponent(
        JSON.stringify({
          type: "block_actions",
          user: { id: "U1" },
          container: { channel_id: CHANNEL, message_ts: "9.9" },
          actions: [{ action_id: actionId, value: conversationId, action_ts: `${Date.now()}` }],
        }),
      )}`;
    const body = press("billie_close");
    expect(
      (
        await interactions(
          new Request(`${url}/interactions`, { method: "POST", body, headers: signed(body) }),
        )
      ).status,
    ).toBe(200);
    const queuedPress = (await db.select().from(jobs).where(eq(jobs.kind, "slack_action"))).filter(
      (j) => JSON.stringify(j.payload).includes(conversationId),
    );
    expect(queuedPress).toHaveLength(1);
    const link = press("billie_link_2");
    await interactions(
      new Request(`${url}/interactions`, { method: "POST", body: link, headers: signed(link) }),
    );
    const forged = await interactions(
      new Request(`${url}/interactions`, {
        method: "POST",
        body,
        headers: signed(body, undefined, "guess"),
      }),
    );
    expect(forged.status).toBe(401);
    const all = (await db.select().from(jobs).where(eq(jobs.kind, "slack_action"))).filter((j) =>
      JSON.stringify(j.payload).includes(conversationId),
    );
    expect(all).toHaveLength(1);
  });
});
