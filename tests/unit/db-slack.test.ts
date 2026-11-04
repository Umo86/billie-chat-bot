import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  botMailboxes,
  bots,
  chatRequests,
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
  submitRequest,
  visitorMessage,
} from "@/lib/conversations/service";
import { notifyHandover } from "@/lib/alerts/notify";
import { runNudges } from "@/lib/alerts/nudge";
import { deliverStaffReply } from "@/lib/conversations/delivery";
import { notifyRequest } from "@/lib/requests/service";
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
        // In a channel shared with another company, which says this is Priya's email.
        UEXT: { email: agent.email, name: "Priya", team: "T0OTHERCO" },
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
    const sly = await visitorMessage({
      bot,
      conversation: fresh!,
      channel: "web",
      text: "<!channel> <https://evil.test|Reset your Slack login>",
    });
    await relayToSlack(sly.messages[0].id);
    const relayed = slack.sent("chat.postMessage").at(-1)!;
    expect(relayed.text).toBe(
      "Visitor: &lt;!channel&gt; &lt;https://evil.test|Reset your Slack login&gt;",
    );
    expect(JSON.stringify(relayed.blocks)).not.toContain('"mrkdwn"');

    // Someone not on Billie, not on this bot, or from another company, can't answer them.
    for (const user of ["USTRANGER", "UOUT", "UEXT"]) {
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
    // Notes stay with the team, however they're written, and so does anything to someone.
    for (const [ts, text] of [
      ["1.2", "note: checking with the electrics contractor"],
      ["1.21", "*Note:* he still owes £5k"],
      ["1.22", "&gt; note: quoted from the sales team"],
      ["1.23", "<@UADMIN> note: can you check the electrics deadline?"],
      ["1.24", "<@UADMIN> can you take this one?"],
      ["1.25", "<!subteam^S0OPS0001|@ops> anyone free?"],
    ])
      await handleThreadReply({ channel: CHANNEL, threadTs: thread.ts, ts, user: "UAGENT", text });
    // Priya answers: it reaches the chat, with her first name, and gets a tick.
    const answer = {
      channel: CHANNEL,
      threadTs: thread.ts,
      ts: "1.3",
      user: "UAGENT",
      text: "Hi Sam, the form is <https://manual.test/electrics|here> &amp; due Friday.",
    };
    await handleThreadReply(answer);
    // Its job running again (say, it was cut off after saving it) doesn't send it twice.
    await handleThreadReply(answer);
    const rows = await db
      .select({ role: messages.role, text: messages.text, authorId: messages.authorId })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    const agentRows = rows.filter((r) => r.role === "agent");
    expect(agentRows).toEqual([
      {
        role: "agent",
        text: "Hi Sam, the form is here (https://manual.test/electrics) & due Friday.",
        authorId: agent.id,
      },
    ]);
    for (const said of ["electrics contractor", "£5k", "quoted", "deadline", "take this", "free?"])
      expect(rows.some((r) => r.text.includes(said))).toBe(false);
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
    const agent = await makeUser("agent");
    const slack = fakeSlack({ people: { UAGENT: { email: agent.email, name: "Priya" } } });
    vi.stubGlobal("fetch", slack.fetchMock);
    const bot = await slackBot();
    await putOnBot(bot.id, agent.id);
    const { conversation } = await startConversation({ bot, channel: "web" });
    const at = new Date();
    await handover(bot, conversation.id, "asked_for_person", at);
    await notifyHandover(conversation.id, "live");
    const statusNow = async () =>
      (await db.query.conversations.findFirst({ where: eq(conversations.id, conversation.id) }))
        ?.status;
    // Four minutes on: still waiting (other tests' chats may be due; this one isn't).
    await expireWaiting(new Date(at.getTime() + 4 * 60_000));
    expect(await statusNow()).toBe("waiting");
    expect(await expireWaiting(new Date(at.getTime() + 6 * 60_000))).toBeGreaterThanOrEqual(1);
    expect(await statusNow()).toBe("collecting");
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
    // In the same thread, and shown in the channel too.
    expect(slack.sent("chat.postMessage").at(-1)).toMatchObject({
      thread_ts: thread.ts,
      reply_broadcast: true,
    });
    const ticketPost = slack.posted.at(-1)!;
    const threads = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, conversation.id));
    expect(threads).toHaveLength(1);
    expect(threads[0].kind).toBe("ticket");
    // A late try of the live alert (its job retrying) posts nothing now.
    const before = slack.sent("chat.postMessage").length;
    await notifyHandover(conversation.id, "live");
    expect(slack.sent("chat.postMessage")).toHaveLength(before);

    // "Close the chat" on the ticket in the thread closes it, and both posts say so.
    await handleSlackAction({
      action: "billie_close",
      conversationId: conversation.id,
      user: "UAGENT",
      channel: CHANNEL,
      ts: ticketPost.ts,
      threadTs: thread.ts,
    });
    const closed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(closed?.status).toBe("closed");
    expect(slack.sent("chat.update").map((u) => u.ts)).toEqual([thread.ts, ticketPost.ts]);
    expect(slack.textOf(slack.sent("chat.update")[1])).toContain("closed this chat");
    // And a ticket alert for a chat that's closed tells nobody.
    await notifyHandover(conversation.id, "ticket");
    expect(slack.sent("chat.postMessage")).toHaveLength(before);
  });
});

describe.skipIf(!hasDb)("Slack: the company-wide channel, and when posting fails", () => {
  const WIDE = "C0WIDE0001";
  afterEach(async () => {
    await db.update(settings).set({ slackChannelId: null, alertEmails: "" });
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  it("gives the company-wide channel a short alert only: no contact details, chat or replies", async () => {
    const manager = await makeUser("editor");
    const slack = fakeSlack();
    vi.stubGlobal("fetch", slack.fetchMock);
    await db.update(settings).set({ slackChannelId: WIDE });
    const { bot: made } = await makeBot(); // no channel of its own
    await db
      .update(bots)
      .set({ rules: { ...defaultRules("exhibitors"), hours: ALWAYS } })
      .where(eq(bots.id, made.id));
    const bot = (await botById(made.id))!;
    await putOnBot(bot.id, manager.id);
    const { conversation } = await startConversation({ bot, channel: "web" });
    await visitorMessage({ bot, conversation, channel: "web", text: "Can we bring a forklift?" });
    await db
      .update(conversations)
      .set({
        contact: {
          name: "Sam Patel",
          company: "Acme Stands",
          email: "sam@acme.test",
          phone: "07700 900123",
        },
      })
      .where(eq(conversations.id, conversation.id));
    await handover(bot, conversation.id, "asked_for_person");
    await notifyHandover(conversation.id, "live");

    const [alert] = slack.sent("chat.postMessage");
    expect(alert.channel).toBe(WIDE);
    const text = slack.textOf(alert);
    expect(text).toContain("someone is waiting for a person");
    expect(text).toContain("Question: Can we bring a forklift?");
    expect(text).toContain("From: Sam Patel, Acme Stands");
    expect(text).toContain("answer it in Billie");
    for (const hidden of ["sam@acme.test", "07700", "The chat so far", "billie_close"])
      expect(text).not.toContain(hidden);
    // No thread to answer in: nothing they write next goes there.
    expect(
      await db.select().from(slackThreads).where(eq(slackThreads.conversationId, conversation.id)),
    ).toHaveLength(0);
    const fresh = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    const next = await visitorMessage({
      bot,
      conversation: fresh!,
      channel: "web",
      text: "My mobile is 07700 900123",
    });
    await relayToSlack(next.messages[0].id);
    await noteInSlack(conversation.id, "Billie suggests: …");
    expect(slack.sent("chat.postMessage")).toHaveLength(1);

    // Email replies to check and the bot's other posts never go there either.
    const address = `wide-${randomUUID().slice(0, 6)}@media-ten.test`;
    await db.insert(botMailboxes).values({ botId: bot.id, address, assignedUserId: manager.id });
    await db.insert(emailThreads).values({
      source: "outlook",
      mailbox: address,
      botId: bot.id,
      fromEmail: "jo@bolt.test",
      subject: "Electrics order",
      status: "draft_ready",
      outlookDraftId: "draft-1",
    });
    await postEmailDigest(bot.id);
    const card = adaptiveMessage({ body: [plainLine("A new request", { bold: true })] });
    expect(
      await postToTeam({ botId: bot.id, teamsLink: null, message: card, ownOnly: true }),
    ).toBeNull();
    expect(slack.sent("chat.postMessage")).toHaveLength(1);
  });

  it("still messages the team and sends the alert email when the channel post fails", async () => {
    const manager = await makeUser("agent");
    process.env.RESEND_API_KEY = "re_test_not_real";
    process.env.EMAIL_FROM = "Billie <billie@media10.test>";
    await db.update(settings).set({ alertEmails: "ops@media-ten.test" });
    const people = { UMAN: { email: manager.email, name: "Sam" } };
    const bot = await slackBot();
    await putOnBot(bot.id, manager.id);
    await db.insert(botMailboxes).values({
      botId: bot.id,
      address: `fail-${randomUUID().slice(0, 6)}@media-ten.test`,
      assignedUserId: manager.id,
    });
    const waitingChat = async () => {
      const { conversation } = await startConversation({ bot, channel: "web" });
      await handover(bot, conversation.id, "asked_for_person");
      return conversation.id;
    };
    const dms = async (id: string) =>
      (await db.select().from(jobs).where(eq(jobs.kind, "slack_direct"))).filter((j) =>
        String(j.dedupeKey).startsWith(`dm:chat:${id}:`),
      ).length;
    const emails = async (id: string) =>
      (await db.select().from(jobs).where(eq(jobs.kind, "alert_email"))).filter((j) =>
        String(j.dedupeKey).startsWith(`alert-email:${id}:`),
      );

    // Billie was taken out of the channel: no point trying again, but the team still hears.
    vi.stubGlobal(
      "fetch",
      fakeSlack({ people, fail: { "chat.postMessage": "not_in_channel" } }).fetchMock,
    );
    const gone = await waitingChat();
    await expect(notifyHandover(gone, "live")).resolves.toBeUndefined();
    expect(await dms(gone)).toBeGreaterThanOrEqual(1);
    expect(await emails(gone)).toHaveLength(1);

    // Slack is busy: tried again, and the messages and email aren't repeated.
    vi.stubGlobal(
      "fetch",
      fakeSlack({ people, fail: { "chat.postMessage": "internal_error" } }).fetchMock,
    );
    const busy = await waitingChat();
    await expect(notifyHandover(busy, "live")).rejects.toThrow(/internal_error/);
    const firstDms = await dms(busy);
    expect(firstDms).toBeGreaterThanOrEqual(1);
    const ok = fakeSlack({ people });
    vi.stubGlobal("fetch", ok.fetchMock);
    await notifyHandover(busy, "live");
    expect(ok.sent("chat.postMessage")).toHaveLength(1);
    expect(await dms(busy)).toBe(firstDms);
    expect(await emails(busy)).toHaveLength(1);
  });

  it("still messages whoever handles a request when its post fails", async () => {
    const manager = await makeUser("agent");
    const hours = {
      id: "hours001",
      name: "Extra build-up hours",
      when: "They need to work outside the build-up hours.",
      handlerId: null,
      fields: [
        { id: "when0001", label: "Which days and times", kind: "long" as const, required: true },
      ],
    };
    const made = await slackBot();
    await db
      .update(bots)
      .set({ requestTypes: [hours] })
      .where(eq(bots.id, made.id));
    const bot = (await botById(made.id))!;
    await putOnBot(bot.id, manager.id);
    await db.insert(botMailboxes).values({
      botId: bot.id,
      address: `req-${randomUUID().slice(0, 6)}@media-ten.test`,
      assignedUserId: manager.id,
    });
    vi.stubGlobal(
      "fetch",
      fakeSlack({
        people: { UMAN: { email: manager.email, name: "Sam" } },
        fail: { "chat.postMessage": "channel_not_found" },
      }).fetchMock,
    );
    const { conversation } = await startConversation({ bot, channel: "web" });
    await submitRequest(bot, conversation.id, hours, [{ label: "When", value: "Friday" }], {
      name: "Sam Lee",
      email: "sam@stands.test",
    });
    const [req] = await db
      .select()
      .from(chatRequests)
      .where(eq(chatRequests.conversationId, conversation.id));
    await expect(notifyRequest(req.id)).resolves.toBeUndefined();
    const dm = (await db.select().from(jobs).where(eq(jobs.kind, "slack_direct"))).filter((j) =>
      String(j.dedupeKey).startsWith(`dm:request:${req.id}:`),
    );
    expect(dm.map((j) => (j.payload as { to: string }).to)).toEqual([manager.email]);
  });
});

describe.skipIf(!hasDb)("Slack and WhatsApp, and nudges", () => {
  it("sends the five-minute line on WhatsApp, and says in the thread when a reply can't go", async () => {
    const agent = await makeUser("agent");
    const slack = fakeSlack({ people: { UAGENT: { email: agent.email, name: "Priya" } } });
    vi.stubGlobal("fetch", slack.fetchMock);
    const bot = await slackBot();
    await putOnBot(bot.id, agent.id);
    const t = await visitorMessage({
      bot,
      conversation: null,
      channel: "whatsapp",
      text: "Can we park at the hall?",
      waId: `4477009${String(Date.now()).slice(-5)}`,
    });
    const at = new Date();
    await handover(bot, t.conversationId, "asked_for_person", at);
    await notifyHandover(t.conversationId, "live");
    const [thread] = await db
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.conversationId, t.conversationId));
    expect(await expireWaiting(new Date(at.getTime() + 6 * 60_000))).toBeGreaterThanOrEqual(1);
    const c = await db.query.conversations.findFirst({
      where: eq(conversations.id, t.conversationId),
    });
    expect(c?.status).toBe("ticket");
    // The line goes to them on WhatsApp (nothing reaches WhatsApp unless it's sent).
    const [line] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, t.conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(line.text).toMatch(/^Sorry, nobody from the team is free right now. They'll reply here/);
    expect(await queued("send_staff_reply", line.id)).toHaveLength(1);
    const waited = (await queued("slack_note", t.conversationId))
      .map((j) => (j.payload as { text: string }).text)
      .find((text) => text.startsWith("Nobody answered"));
    expect(waited).toContain("Reply in this thread: it goes to them on WhatsApp.");

    // Priya answers in the thread: no tick until it's sent, and it can't be (WhatsApp is off).
    await handleThreadReply({
      channel: CHANNEL,
      threadTs: thread.ts,
      ts: "7.1",
      user: "UAGENT",
      text: "Yes, in car park B.",
    });
    expect(slack.sent("reactions.add")).toHaveLength(0);
    const [reply] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, t.conversationId), eq(messages.role, "agent")));
    await deliverStaffReply(reply.id, "whatsapp");
    const notes = (await queued("slack_note", t.conversationId)).map(
      (j) => (j.payload as { text: string }).text,
    );
    expect(notes).toContain("That reply didn't reach them. Not sent: WhatsApp isn't connected.");
  });

  it("nudges by Slack direct message, without the Teams one set up", async () => {
    const manager = await makeUser("agent");
    await db.update(settings).set({ teamsDmWebhookUrl: null, nudgeAfterHours: 4 });
    const { bot } = await makeBot();
    await putOnBot(bot.id, manager.id);
    await db.insert(botMailboxes).values({
      botId: bot.id,
      address: `nudge-${randomUUID().slice(0, 6)}@media-ten.test`,
      assignedUserId: manager.id,
    });
    const [chat] = await db
      .insert(conversations)
      .values({
        botId: bot.id,
        channel: "web",
        status: "ticket",
        handoverAt: new Date("2026-11-02T10:00:00Z"),
        firstQuestion: "Can we build until 22:00?",
        contact: { name: "Sam Lee", company: "Northern Stands" },
      })
      .returning();
    await runNudges(new Date("2026-11-04T15:00:00Z"));
    const to = (await db.select().from(jobs).where(eq(jobs.kind, "slack_direct")))
      .filter((j) => String(j.dedupeKey).startsWith(`dm:nudge:chat:${chat.id}:`))
      .map((j) => (j.payload as { to: string }).to);
    expect(to).toContain(manager.email);
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
    // A reply also sent to the channel counts too.
    const broadcastId = `Ev${randomUUID().slice(0, 8)}`;
    const broadcast = JSON.stringify({
      type: "event_callback",
      event_id: broadcastId,
      event: {
        type: "message",
        subtype: "thread_broadcast",
        user: "U1",
        text: "On it, everyone",
        channel: CHANNEL,
        ts: "2.3",
        thread_ts: "1.1",
      },
    });
    await events(
      new Request(`${url}/events`, { method: "POST", body: broadcast, headers: signed(broadcast) }),
    );
    expect(await byKey(`slack-event:${broadcastId}`)).toHaveLength(1);
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
          // On a reply: a ticket posted in a live chat's thread.
          container: { channel_id: CHANNEL, message_ts: "9.9", thread_ts: "8.8" },
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
    expect(queuedPress[0].payload).toMatchObject({ ts: "9.9", threadTs: "8.8" });
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
