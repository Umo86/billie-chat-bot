import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, botMailboxes, bots, emailThreads, jobs, users } from "@/lib/db/schema";
import {
  botEmailSetup,
  mailboxOverview,
  removeMailbox,
  saveMailbox,
  setTeamsLink,
} from "@/lib/emails/mailboxes";
import { checkMailbox, syncAllMailboxes } from "@/lib/channels/outlook";
import { processEmail } from "@/lib/emails/process";
import { deliverEmailDraft } from "@/lib/emails/deliver";
import { redoDraft } from "@/lib/emails/service";
import { deleteBot } from "@/lib/bots/service";
import { notifyHandover } from "@/lib/alerts/notify";
import { startConversation } from "@/lib/conversations/service";
import { deletePerson } from "@/lib/privacy/requests";
import { addAndRead, hasDb, makeBot, makeUser } from "../helpers/db";
import { fakeMicrosoft, message, TEAMS } from "../helpers/microsoft";

const uid = () => randomUUID().slice(0, 8);

/** As if Billie started reading this mailbox a while ago (its first sync sets this). */
async function startedReading(address: string, ago = 3_600_000) {
  await db
    .update(botMailboxes)
    .set({ syncFrom: new Date(Date.now() - ago) })
    .where(eq(botMailboxes.address, address));
}

async function latestJob(kind: "process_email" | "deliver_email_draft", emailId: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, kind), sql`${jobs.payload}->>'emailId' = ${emailId}`))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return job;
}

async function emailRow(id: string) {
  return db.query.emailThreads.findFirst({ where: eq(emailThreads.id, id) });
}

describe.skipIf(!hasDb)("event mailboxes and Teams (Postgres, stand-in Microsoft 365)", () => {
  beforeAll(() => {
    // Made-up values: requests go to the stand-in (tests/helpers/microsoft.ts), never to Microsoft.
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
    // Leave no mailboxes switched on for the other test files.
    await db.update(botMailboxes).set({ enabled: false });
  });

  it("connects a mailbox to one bot only, managed by someone who can sign in", async () => {
    const admin = await makeUser("admin");
    const manager = await makeUser("agent");
    const { bot } = await makeBot();
    const { bot: other } = await makeBot();
    const address = `ukcw-${uid()}@media-ten.test`;

    await saveMailbox(admin, bot.id, {
      address: `  ${address.toUpperCase()} `,
      assignedUserId: manager.id,
      enabled: true,
    });
    expect((await botEmailSetup(bot.id)).mailbox).toMatchObject({
      address,
      assignedUserId: manager.id,
      enabled: true,
      lastError: null,
    });
    await expect(
      saveMailbox(admin, other.id, { address, assignedUserId: null, enabled: true }),
    ).rejects.toThrow(`Exhibitor Help already uses ${address}`);

    const [left] = await db
      .insert(users)
      .values({ email: `${uid()}@example.test`, fullName: "Left", status: "suspended" })
      .returning();
    await expect(
      saveMailbox(admin, bot.id, { address, assignedUserId: left.id, enabled: true }),
    ).rejects.toThrow("Choose someone on the team who can sign in.");

    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, bot.id));
    expect(audit.map((a) => a.summary)).toContain(`Connected ${address} to "Exhibitor Help"`);

    // A deleted bot gives its mailbox up to a new one.
    await deleteBot(admin, bot.id);
    await saveMailbox(admin, other.id, { address, assignedUserId: null, enabled: true });
    expect((await botEmailSetup(other.id)).mailbox?.address).toBe(address);
    expect((await botEmailSetup(bot.id)).mailbox).toBeNull();

    await removeMailbox(admin, other.id);
    expect((await botEmailSetup(other.id)).mailbox).toBeNull();
  });

  it("checks the Teams link, and only ever shows its host", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    await saveMailbox(admin, bot.id, {
      address: `teams-${uid()}@media-ten.test`,
      assignedUserId: null,
      enabled: false,
    });
    await expect(setTeamsLink(admin, bot.id, "https://hooks.evil.example/x")).rejects.toThrow(
      /isn't a Teams Workflows link/,
    );
    await setTeamsLink(admin, bot.id, TEAMS);
    expect((await botEmailSetup(bot.id)).teams).toBe("prod-12.uksouth.logic.azure.com");
    const overview = (await mailboxOverview()).find((m) => m.botId === bot.id);
    expect(overview?.teams).toBe(true);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, bot.id));
    expect(JSON.stringify(audit)).not.toContain("test-signature");
    expect(JSON.stringify(await mailboxOverview())).not.toContain("test-signature");
  });

  it("turns new mail into a draft in Outlook and a Teams post for the manager", async () => {
    const admin = await makeUser("admin");
    const manager = await makeUser("agent");
    const { bot, kb } = await makeBot();
    await addAndRead(admin, kb.id, {
      kind: "text",
      title: "Build-up",
      body: "Build-up starts on Monday 8 March at 8am.",
    });
    await db
      .update(bots)
      .set({ emailSignOff: "Best wishes,\nThe UKCW team" })
      .where(eq(bots.id, bot.id));
    const address = `ukcw-${uid()}@media-ten.test`;
    await saveMailbox(admin, bot.id, { address, assignedUserId: manager.id, enabled: true });
    await setTeamsLink(admin, bot.id, TEAMS);
    await startedReading(address);

    const id = uid();
    const ms = fakeMicrosoft({
      [address]: {
        value: [
          message(
            `msg-${id}`,
            "Sam@Stands.example",
            "Build-up question",
            "Hi, when does build-up start? Thanks, Sam",
            "Sam Carter",
          ),
          message(
            `ooo-${id}`,
            "pat@stands.example",
            "Automatic reply: Exhibitor manual",
            "I'm away",
          ),
          message(`own-${id}`, address, "Note to self", "x"),
          { ...message(`dr-${id}`, "sam@stands.example", "Draft", "x"), isDraft: true },
        ],
      },
    });
    vi.stubGlobal("fetch", ms.fetchMock);

    await syncAllMailboxes();
    const rows = await db.select().from(emailThreads).where(eq(emailThreads.mailbox, address));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "outlook",
      externalId: `msg-${id}`,
      botId: bot.id,
      fromName: "Sam Carter",
      fromEmail: "sam@stands.example",
      status: "new",
    });
    const box = await db.query.botMailboxes.findFirst({
      where: eq(botMailboxes.address, address),
    });
    expect(box).toMatchObject({ lastError: null });
    expect(box?.deltaLink).toContain("$deltatoken=next");
    expect(box?.lastSyncedAt).toBeInstanceOf(Date);
    // The first request asks only for mail since Billie started reading.
    const first = ms.calls.find((c) => c.url.includes(encodeURIComponent(address)));
    expect(decodeURIComponent(first!.url)).toMatch(
      /\$filter=receivedDateTime\+ge\+\d{4}-\d\d-\d\dT/,
    );

    // Synced again: the same email isn't added twice.
    await syncAllMailboxes();
    expect(
      await db.select().from(emailThreads).where(eq(emailThreads.mailbox, address)),
    ).toHaveLength(1);

    // Billie drafts the reply with the bot's sign-off (the job the sync queued), then queues the delivery.
    await processEmail(rows[0].id);
    await db
      .update(jobs)
      .set({ status: "done" })
      .where(and(eq(jobs.kind, "process_email"), sql`${jobs.payload}->>'emailId' = ${rows[0].id}`));
    const drafted = await db.query.emailThreads.findFirst({
      where: eq(emailThreads.id, rows[0].id),
    });
    expect(drafted?.status).toBe("draft_ready");
    expect(drafted?.draft).toMatch(/^Hi Sam,/);
    expect(drafted?.draft).toContain("8am");
    expect(drafted?.draft).toContain("Best wishes,\nThe UKCW team");
    const [deliver] = await db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.kind, "deliver_email_draft"), sql`${jobs.payload}->>'emailId' = ${rows[0].id}`),
      );
    expect(deliver.payload).toEqual({ emailId: rows[0].id });

    ms.calls.length = 0;
    await deliverEmailDraft(rows[0].id);
    const reply = ms.calls.find((c) => c.url.endsWith(`/messages/msg-${id}/createReply`));
    expect(reply?.method).toBe("POST");
    const fill = ms.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/messages/draft-1"));
    const html = (fill?.body as { body: { contentType: string; content: string } }).body;
    expect(html.contentType).toBe("HTML");
    expect(html.content).toMatch(/<body dir="ltr"><div style="[^"]+">Hi Sam,<br><br>/);
    expect(html.content).toContain("Best wishes,<br>The UKCW team");
    expect(html.content).toContain("<div>Original email</div>");
    const tag = ms.calls.find((c) => c.method === "PATCH" && c.url.endsWith(`/messages/msg-${id}`));
    expect((tag?.body as { categories: string[] }).categories).toEqual(
      expect.arrayContaining(["VIP", "Billie: draft ready"]),
    );
    const teams = ms.calls.filter((c) => c.url.startsWith("https://prod-12."));
    expect(teams).toHaveLength(1);
    const card = JSON.stringify(teams[0].body);
    expect(card).toContain("Exhibitor Help: a reply is waiting in Drafts");
    expect(card).toContain(`Billie's reply is in Drafts in ${address}.`);
    expect(card).toContain("<at>Sam Tester</at>");
    expect(card).toContain(manager.email);
    expect(card).toContain(`/emails?e=${rows[0].id}`);
    expect(
      (await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, rows[0].id) }))
        ?.outlookDraftId,
    ).toBe("draft-1");

    // Run again (a retry): still one draft in Outlook.
    ms.calls.length = 0;
    await deliverEmailDraft(rows[0].id);
    expect(ms.calls.some((c) => c.url.endsWith("/createReply"))).toBe(false);

    // The team asks for the draft again (here after changing the sign-off): the new
    // draft goes into Drafts and Billie's untouched old one goes, without another post.
    await db.update(bots).set({ emailSignOff: "Thanks,\nUKCW" }).where(eq(bots.id, bot.id));
    await redoDraft(admin, rows[0].id);
    expect((await latestJob("process_email", rows[0].id)).payload).toEqual({
      emailId: rows[0].id,
      redo: true,
    });
    await processEmail(rows[0].id, { redo: true });
    expect((await latestJob("deliver_email_draft", rows[0].id)).payload).toEqual({
      emailId: rows[0].id,
      quiet: true,
    });
    ms.calls.length = 0;
    await deliverEmailDraft(rows[0].id, { quiet: true });
    expect(ms.calls.filter((c) => c.url.endsWith("/createReply"))).toHaveLength(1);
    const removed = ms.calls.find(
      (c) => c.method === "DELETE" && c.url.endsWith("/messages/draft-1"),
    );
    expect(removed?.ifMatch).toBe('W/"draft-1-v2"'); // only the version Billie wrote
    expect(ms.etags.has("draft-1")).toBe(false);
    expect(ms.calls.some((c) => c.url.startsWith("https://prod-12."))).toBe(false);
    expect(await emailRow(rows[0].id)).toMatchObject({
      outlookDraftId: "draft-2",
      outlookDraftEtag: 'W/"draft-2-v2"',
    });
    // The same text again changes nothing in Outlook.
    ms.calls.length = 0;
    await deliverEmailDraft(rows[0].id, { quiet: true });
    expect(ms.calls.some((c) => c.url.endsWith("/createReply"))).toBe(false);

    // Someone edits Billie's draft in Outlook, then the team asks again: their draft stays.
    ms.edit("draft-2");
    await db.update(bots).set({ emailSignOff: "Cheers,\nUKCW" }).where(eq(bots.id, bot.id));
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.kind, "process_email"));
    await redoDraft(admin, rows[0].id);
    await processEmail(rows[0].id, { redo: true });
    ms.calls.length = 0;
    await deliverEmailDraft(rows[0].id, { quiet: true });
    const refused = ms.calls.find(
      (c) => c.method === "DELETE" && c.url.endsWith("/messages/draft-2"),
    );
    expect(refused?.ifMatch).toBe('W/"draft-2-v2"'); // Outlook says no: it has changed
    expect(ms.etags.has("draft-2")).toBe(true);
    expect((await emailRow(rows[0].id))?.outlookDraftId).toBe("draft-3");
  });

  it("tells the manager when an email needs a person, with no draft", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const address = `refunds-${uid()}@media-ten.test`;
    await saveMailbox(admin, bot.id, { address, assignedUserId: null, enabled: true });
    await setTeamsLink(admin, bot.id, TEAMS);
    await startedReading(address);
    const id = uid();
    const ms = fakeMicrosoft({
      [address]: {
        value: [
          message(
            `ref-${id}`,
            "priya@example.com",
            "Refund please",
            "Please refund our furniture order.",
            "Priya Shah",
          ),
        ],
      },
    });
    vi.stubGlobal("fetch", ms.fetchMock);
    await syncAllMailboxes();
    const [email] = await db.select().from(emailThreads).where(eq(emailThreads.mailbox, address));
    await processEmail(email.id);
    ms.calls.length = 0;
    await deliverEmailDraft(email.id);
    expect(ms.calls.some((c) => c.url.endsWith("/createReply"))).toBe(false);
    const tag = ms.calls.find((c) => c.method === "PATCH");
    expect((tag?.body as { categories: string[] }).categories).toContain("Billie: needs you");
    const card = JSON.stringify(ms.calls.find((c) => c.url.startsWith("https://prod-12."))?.body);
    expect(card).toContain("Exhibitor Help: an email needs a person");
    expect(card).toContain("This topic always goes to a person.");
    expect(card).toContain(`There's no draft. Reply from ${address}.`);
    expect(card).not.toContain("<at>"); // nobody manages it yet
  });

  it("keeps going when one mailbox can't be opened, and says why in words", async () => {
    const admin = await makeUser("admin");
    const { bot: a } = await makeBot();
    const { bot: b } = await makeBot();
    const blocked = `blocked-${uid()}@media-ten.test`;
    const fine = `fine-${uid()}@media-ten.test`;
    await saveMailbox(admin, a.id, { address: blocked, assignedUserId: null, enabled: true });
    await saveMailbox(admin, b.id, { address: fine, assignedUserId: null, enabled: true });
    await startedReading(fine);
    // The fine mailbox's sync point has expired: Billie starts it again.
    const expired = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fine)}/mailFolders/inbox/messages/delta?$deltatoken=old`;
    await db.update(botMailboxes).set({ deltaLink: expired }).where(eq(botMailboxes.address, fine));
    const ms = fakeMicrosoft({
      [blocked]: { status: 403 },
      [fine]: {
        expiredToken: "deltatoken=old",
        value: [
          message(`ok-${uid()}`, "sam@stands.example", "Badges", "How many badges do we get?"),
        ],
      },
    });
    vi.stubGlobal("fetch", ms.fetchMock);

    const result = await syncAllMailboxes();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const bad = await db.query.botMailboxes.findFirst({ where: eq(botMailboxes.address, blocked) });
    expect(bad?.lastError).toMatch(/isn't allowed into this mailbox yet/);
    const good = await db.query.botMailboxes.findFirst({ where: eq(botMailboxes.address, fine) });
    expect(good).toMatchObject({ lastError: null });
    expect(good?.deltaLink).toContain("$deltatoken=next");
    expect(await db.select().from(emailThreads).where(eq(emailThreads.mailbox, fine))).toHaveLength(
      1,
    );

    // Switched off: Billie doesn't open it at all.
    await saveMailbox(admin, a.id, { address: blocked, assignedUserId: null, enabled: false });
    ms.calls.length = 0;
    await syncAllMailboxes();
    expect(ms.calls.some((c) => c.url.includes(encodeURIComponent(blocked)))).toBe(false);
  });

  it("drafts only mail that arrives after Billie starts reading, and never old mail again", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const address = `start-${uid()}@media-ten.test`;
    await saveMailbox(admin, bot.id, { address, assignedUserId: null, enabled: true });
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
    const value: unknown[] = [
      message(`before-${uid()}`, "sam@stands.example", "Already here", "x", "", minutesAgo(5)),
    ];
    const ms = fakeMicrosoft({ [address]: { value } });
    vi.stubGlobal("fetch", ms.fetchMock);
    const count = async () =>
      (await db.select().from(emailThreads).where(eq(emailThreads.mailbox, address))).length;

    // The first sync starts now: what's already in the inbox isn't drafted.
    await syncAllMailboxes();
    expect(await count()).toBe(0);
    const box = await db.query.botMailboxes.findFirst({ where: eq(botMailboxes.address, address) });
    expect(box?.syncFrom).toBeInstanceOf(Date);

    // New mail is.
    value.push(
      message(
        `new-${uid()}`,
        "sam@stands.example",
        "New question",
        "x",
        "",
        new Date(Date.now() + 1000),
      ),
    );
    await syncAllMailboxes();
    expect(await count()).toBe(1);

    // Old mail shows up again when something changes on it (read, flagged): it's left alone,
    // so emails removed by retention never come back.
    value.push(
      message(
        `old-${uid()}`,
        "sam@stands.example",
        "Last year",
        "x",
        "",
        minutesAgo(60 * 24 * 400),
      ),
    );
    await syncAllMailboxes();
    expect(await count()).toBe(1);

    // Switched off, then on again: Billie starts afresh, without the mail from while it was off.
    await saveMailbox(admin, bot.id, { address, assignedUserId: null, enabled: false });
    await saveMailbox(admin, bot.id, { address, assignedUserId: null, enabled: true });
    expect(
      await db.query.botMailboxes.findFirst({ where: eq(botMailboxes.address, address) }),
    ).toMatchObject({ syncFrom: null, deltaLink: null });
    value.push(message(`off-${uid()}`, "sam@stands.example", "While off", "x", "", minutesAgo(2)));
    await syncAllMailboxes();
    expect(await count()).toBe(1);
  });

  it("never takes in again an email a person asked Billie to forget", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const address = `gdpr-${uid()}@media-ten.test`;
    await saveMailbox(admin, bot.id, { address, assignedUserId: null, enabled: true });
    await startedReading(address);
    const sender = `erase-${uid()}@example.com`;
    const ms = fakeMicrosoft({
      [address]: { value: [message(`gdpr-${uid()}`, sender, "Question", "Please call me.")] },
    });
    vi.stubGlobal("fetch", ms.fetchMock);
    await syncAllMailboxes();
    expect(
      await db.select().from(emailThreads).where(eq(emailThreads.mailbox, address)),
    ).toHaveLength(1);

    await deletePerson(admin, sender);
    expect(
      await db.select().from(emailThreads).where(eq(emailThreads.mailbox, address)),
    ).toHaveLength(0);
    // The email changes in Outlook, so the sync sees it again: it stays forgotten.
    await db.update(botMailboxes).set({ deltaLink: null }).where(eq(botMailboxes.address, address));
    await syncAllMailboxes();
    expect(
      await db.select().from(emailThreads).where(eq(emailThreads.mailbox, address)),
    ).toHaveLength(0);
  });

  it("keeps the reply in Billie when Outlook won't take it, and still tells the team", async () => {
    const admin = await makeUser("admin");
    const { bot, kb } = await makeBot();
    await addAndRead(admin, kb.id, {
      kind: "text",
      title: "Badges",
      body: "Each exhibitor gets four badges.",
    });
    const address = `readonly-${uid()}@media-ten.test`;
    await saveMailbox(admin, bot.id, { address, assignedUserId: null, enabled: true });
    await setTeamsLink(admin, bot.id, TEAMS);
    await startedReading(address);
    const inbox = {
      [address]: {
        value: [
          message(
            `ro1-${uid()}`,
            "sam@stands.example",
            "Badges",
            "How many badges do we get?",
            "Sam",
          ),
          message(`ro2-${uid()}`, "kim@stands.example", "Badges", "How many badges?", "Kim"),
        ],
      },
    };
    // Read-only access: a refusal that won't fix itself.
    const readOnly = fakeMicrosoft(inbox, { refuseDrafts: 403 });
    vi.stubGlobal("fetch", readOnly.fetchMock);
    await syncAllMailboxes();
    const [a, b] = await db
      .select()
      .from(emailThreads)
      .where(eq(emailThreads.mailbox, address))
      .orderBy(emailThreads.fromEmail);
    await processEmail(a.id);
    await processEmail(b.id);
    await deliverEmailDraft(b.id);
    expect((await emailRow(b.id))?.error).toMatch(
      /^Billie couldn't save this reply in Outlook\. Billie can read this mailbox but isn't allowed to save drafts/,
    );
    expect(
      (await db.query.botMailboxes.findFirst({ where: eq(botMailboxes.address, address) }))
        ?.draftError,
    ).toMatch(/isn't allowed to save drafts/);
    const post = JSON.stringify(readOnly.calls.find((c) => c.url === TEAMS)?.body);
    expect(post).toContain("a reply is ready in Billie");
    expect(post).toContain(`couldn't be saved in Drafts in ${address}`);

    // Microsoft busy: tried again later, and on the last try the team is told anyway.
    const busy = fakeMicrosoft(inbox, { refuseDrafts: 503 });
    vi.stubGlobal("fetch", busy.fetchMock);
    await expect(deliverEmailDraft(a.id)).rejects.toThrow(/Graph 503/);
    expect(busy.calls.some((c) => c.url === TEAMS)).toBe(false);
    await deliverEmailDraft(a.id, { lastTry: true });
    expect((await emailRow(a.id))?.error).toMatch(/couldn't save this reply in Outlook/);
    expect(busy.calls.some((c) => c.url === TEAMS)).toBe(true);

    // Once a draft is saved again, the mailbox's problem clears.
    vi.stubGlobal("fetch", fakeMicrosoft(inbox).fetchMock);
    await deliverEmailDraft(a.id);
    expect(await emailRow(a.id)).toMatchObject({ error: null, outlookDraftId: "draft-1" });
    expect(
      (await db.query.botMailboxes.findFirst({ where: eq(botMailboxes.address, address) }))
        ?.draftError,
    ).toBeNull();
  });

  it("checks it can read the inbox and save a draft, leaving nothing behind", async () => {
    const address = `check-${uid()}@media-ten.test`;
    const ok = fakeMicrosoft({});
    vi.stubGlobal("fetch", ok.fetchMock);
    expect(await checkMailbox(address)).toBeNull();
    const removed = ok.calls.find((c) => c.url.endsWith("/permanentDelete"));
    expect(removed?.ifMatch).toBe('W/"draft-1-v1"');
    expect(ok.etags.size).toBe(0);
    vi.stubGlobal("fetch", fakeMicrosoft({}, { refuseDrafts: 403 }).fetchMock);
    expect(await checkMailbox(address)).toMatch(/isn't allowed to save drafts/);
  });

  it("posts chats that need a person to the bot's own Teams channel", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    await setTeamsLink(admin, bot.id, TEAMS);
    const { conversation } = await startConversation({ bot, channel: "web" });
    const ms = fakeMicrosoft({});
    vi.stubGlobal("fetch", ms.fetchMock);
    await notifyHandover(conversation.id, "ticket");
    const posts = ms.calls.filter((c) => c.url === TEAMS);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0].body)).toContain("Exhibitor Help: a question needs a reply");
  });
});
