import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  auditLog,
  botMailboxes,
  conversations,
  emailThreads,
  jobs,
  messages,
  settings,
} from "@/lib/db/schema";
import { directLinkLabel, queueDirect, sendDirect, setDirectLink } from "@/lib/alerts/direct";
import { enqueue } from "@/lib/jobs/queue";
import { notifyHandover } from "@/lib/alerts/notify";
import { saveRoutes } from "@/lib/conversations/routing";
import { startConversation } from "@/lib/conversations/service";
import { saveMailbox } from "@/lib/emails/mailboxes";
import { syncAllMailboxes } from "@/lib/channels/outlook";
import { processEmail } from "@/lib/emails/process";
import { deliverEmailDraft } from "@/lib/emails/deliver";
import {
  clearPresence,
  hasDb,
  makeBot,
  makeUser,
  putOnBot,
  setAvailableAgent,
} from "../helpers/db";
import { DIRECT, fakeMicrosoft, message, TEAMS } from "../helpers/microsoft";

const uid = () => randomUUID().slice(0, 8);

async function directJobs(prefix: string) {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "teams_direct"), like(jobs.dedupeKey, `${prefix}%`)));
}

describe.skipIf(!hasDb)("Teams messages to people (Postgres, stand-in Teams)", () => {
  beforeAll(() => {
    process.env.MS_TENANT_ID = "tenant-test";
    process.env.MS_CLIENT_ID = "client-test";
    process.env.MS_CLIENT_SECRET = "not-a-real-secret";
    delete process.env.TEAMS_WEBHOOK_URL;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    delete process.env.MS_TENANT_ID;
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
    await db.update(settings).set({ teamsDmWebhookUrl: null });
    await clearPresence();
  });

  it("checks the workflow link, and only ever shows its host", async () => {
    const admin = await makeUser("admin");
    await expect(setDirectLink(admin, "https://hooks.evil.example/x")).rejects.toThrow(
      /isn't a Teams Workflows link/,
    );
    await setDirectLink(admin, DIRECT);
    expect(await directLinkLabel()).toBe("prod-34.uksouth.logic.azure.com");
    const audit = await db.select().from(auditLog).where(eq(auditLog.actorUserId, admin.id));
    expect(audit.map((a) => a.summary)).toContain(
      "Set up Teams direct messages (prod-34.uksouth.logic.azure.com)",
    );
    expect(JSON.stringify(audit)).not.toContain("direct-signature");
  });

  it("queues each message once, however often the job that queued it runs", async () => {
    const admin = await makeUser("admin");
    await setDirectLink(admin, DIRECT);
    const key = `test:${uid()}`;
    const card = { type: "AdaptiveCard", body: [] };
    expect(await queueDirect([{ email: " Sam@Media-Ten.test " }], key, card)).toBe(1);
    expect(await queueDirect([{ email: "sam@media-ten.test" }], key, card)).toBe(0);
    // Still not after the first one has been sent.
    await db
      .update(jobs)
      .set({ status: "done" })
      .where(like(jobs.dedupeKey, `dm:${key}:%`));
    expect(await queueDirect([{ email: "sam@media-ten.test" }], key, card)).toBe(0);
    const [job] = await directJobs(`dm:${key}:`);
    expect(job.payload).toEqual({ to: "sam@media-ten.test", card });
    // Plain dedupe keys (without once) can be queued again once finished.
    const plain = `plain:${uid()}`;
    expect(await enqueue("outlook_sync", {}, { dedupeKey: plain })).toBeTruthy();
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.dedupeKey, plain));
    expect(await enqueue("outlook_sync", {}, { dedupeKey: plain })).toBeTruthy();
  });

  it("sends the person and the card to the workflow, and stops when it's turned off", async () => {
    const admin = await makeUser("admin");
    await setDirectLink(admin, DIRECT);
    const ms = fakeMicrosoft({});
    vi.stubGlobal("fetch", ms.fetchMock);
    const card = { type: "AdaptiveCard", version: "1.4", body: [] };
    await sendDirect("sam@media-ten.test", card);
    expect(ms.calls).toEqual([
      {
        method: "POST",
        url: DIRECT,
        body: { recipient: "sam@media-ten.test", card: JSON.stringify(card) },
      },
    ]);
    await setDirectLink(admin, null);
    ms.calls.length = 0;
    await sendDirect("sam@media-ten.test", card);
    expect(ms.calls).toHaveLength(0);
    expect(await queueDirect([{ email: "sam@media-ten.test" }], `off:${uid()}`, card)).toBe(0);
  });

  it("messages the mailbox manager when a reply is waiting in Drafts, once", async () => {
    const admin = await makeUser("admin");
    const manager = await makeUser("agent");
    await setDirectLink(admin, DIRECT);
    const { bot } = await makeBot();
    await putOnBot(bot.id, manager.id);
    const address = `dm-${uid()}@media-ten.test`;
    await saveMailbox(admin, bot.id, { address, assignedUserId: manager.id, enabled: true });
    // As if Billie started reading this mailbox an hour ago.
    await db
      .update(botMailboxes)
      .set({ syncFrom: new Date(Date.now() - 3_600_000) })
      .where(eq(botMailboxes.address, address));
    // No channel for this bot: email posts never go to the company-wide channel.
    process.env.TEAMS_WEBHOOK_URL = TEAMS;
    const ms = fakeMicrosoft({
      [address]: {
        value: [
          message(`m-${uid()}`, "sam@stands.example", "Build-up", "When is build-up?", "Sam"),
        ],
      },
    });
    vi.stubGlobal("fetch", ms.fetchMock);
    try {
      await syncAllMailboxes();
      const [email] = await db.select().from(emailThreads).where(eq(emailThreads.mailbox, address));
      await processEmail(email.id);
      await deliverEmailDraft(email.id);
      await deliverEmailDraft(email.id); // a retry
      const queued = await directJobs(`dm:email:${email.id}:`);
      expect(queued).toHaveLength(1);
      expect((queued[0].payload as { to: string }).to).toBe(manager.email);
      const card = JSON.stringify((queued[0].payload as { card: unknown }).card);
      expect(card).toContain("Exhibitor Help: an email needs a person"); // nothing in its knowledge
      expect(card).not.toContain("<at>"); // a message of their own needs no @mention
      expect(ms.calls.some((c) => c.url === TEAMS)).toBe(false);
    } finally {
      delete process.env.TEAMS_WEBHOOK_URL;
    }
  });

  it("messages whoever is available about a waiting chat; when nobody is, the event's manager", async () => {
    const admin = await makeUser("admin");
    const onDuty = await makeUser("agent");
    const manager = await makeUser("agent");
    await setDirectLink(admin, DIRECT);
    const { bot } = await makeBot();
    await putOnBot(bot.id, onDuty.id, manager.id);
    await saveMailbox(admin, bot.id, {
      address: `chat-${uid()}@media-ten.test`,
      assignedUserId: manager.id,
      enabled: false,
    });
    vi.stubGlobal("fetch", fakeMicrosoft({}).fetchMock);

    await clearPresence();
    await setAvailableAgent(onDuty.id, true);
    const { conversation: live } = await startConversation({ bot, channel: "web" });
    await notifyHandover(live.id, "live");
    await notifyHandover(live.id, "live"); // a retry
    const toLive = await directJobs(`dm:chat:${live.id}:`);
    expect(toLive.map((j) => (j.payload as { to: string }).to)).toEqual([onDuty.email]);
    expect(JSON.stringify(toLive[0].payload)).toContain("someone is waiting for a person");

    await clearPresence();
    const { conversation: ticket } = await startConversation({ bot, channel: "web" });
    await notifyHandover(ticket.id, "ticket");
    const toTicket = await directJobs(`dm:chat:${ticket.id}:`);
    expect(toTicket.map((j) => (j.payload as { to: string }).to)).toEqual([manager.email]);
    expect(JSON.stringify(toTicket[0].payload)).toContain("a question needs a reply");
  });

  it("sends a chat or email about a topic to whoever handles it first", async () => {
    const admin = await makeUser("admin");
    const onDuty = await makeUser("agent");
    const sparky = await makeUser("agent");
    const manager = await makeUser("agent");
    const stranger = await makeUser("agent");
    await setDirectLink(admin, DIRECT);
    const { bot } = await makeBot();
    await putOnBot(bot.id, onDuty.id, sparky.id, manager.id);
    const address = `routes-${uid()}@media-ten.test`;
    await saveMailbox(admin, bot.id, { address, assignedUserId: manager.id, enabled: true });
    const rule = { id: "electrics1", topic: "Electrics", words: ["electric", "power"] };
    await expect(saveRoutes(admin, bot.id, [{ ...rule, userId: stranger.id }])).rejects.toThrow(
      /works on this bot/,
    );
    await saveRoutes(admin, bot.id, [{ ...rule, userId: sparky.id }]);
    vi.stubGlobal("fetch", fakeMicrosoft({}).fetchMock);
    const chatAbout = async (text: string) => {
      const { conversation } = await startConversation({ bot, channel: "web" });
      await db.insert(messages).values({ conversationId: conversation.id, role: "visitor", text });
      return conversation;
    };
    const to = async (id: string) =>
      (await directJobs(`dm:chat:${id}:`)).map((j) => (j.payload as { to: string }).to).sort();

    // A live chat about electrics: the electrics person first, and whoever is available.
    await clearPresence();
    await setAvailableAgent(onDuty.id, true);
    const live = await chatAbout("Can we get extra electrics on our stand?");
    await notifyHandover(live.id, "live");
    expect(await to(live.id)).toEqual([onDuty.email, sparky.email].sort());
    const job = (await directJobs(`dm:chat:${live.id}:`)).find(
      (j) => (j.payload as { to: string }).to === sparky.email,
    )!;
    expect(JSON.stringify(job.payload)).toContain("About: Electrics, which Sam Tester handles");
    const given = await db.query.conversations.findFirst({ where: eq(conversations.id, live.id) });
    expect(given?.assignedTo).toBe(sparky.id);

    // When they're available themselves, only them.
    await setAvailableAgent(sparky.id, true);
    const again = await chatAbout("Is there power at the back of the hall?");
    await notifyHandover(again.id, "live");
    expect(await to(again.id)).toEqual([sparky.email]);

    // Anything else goes as before: here the event's manager, for a ticket.
    await clearPresence();
    const parking = await chatAbout("Where do we park?");
    await notifyHandover(parking.id, "ticket");
    expect(await to(parking.id)).toEqual([manager.email]);

    // An email that needs a person, about electrics: to them, not the mailbox's manager.
    await db
      .update(botMailboxes)
      .set({ syncFrom: new Date(Date.now() - 3_600_000) })
      .where(eq(botMailboxes.address, address));
    const ms = fakeMicrosoft({
      [address]: {
        value: [
          message(
            `m-${uid()}`,
            "jo@stands.example",
            "Electrics",
            "Can we add two power sockets?",
            "Jo",
          ),
        ],
      },
    });
    vi.stubGlobal("fetch", ms.fetchMock);
    await syncAllMailboxes();
    const [email] = await db.select().from(emailThreads).where(eq(emailThreads.mailbox, address));
    await processEmail(email.id);
    await deliverEmailDraft(email.id);
    const after = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, email.id) });
    expect(after).toMatchObject({ status: "needs_you", routedTo: sparky.id });
    const emailed = await directJobs(`dm:email:${email.id}:`);
    expect(emailed.map((j) => (j.payload as { to: string }).to)).toEqual([sparky.email]);
  });
});
