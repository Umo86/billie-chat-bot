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
import { syncAllMailboxes } from "@/lib/channels/outlook";
import { processEmail } from "@/lib/emails/process";
import { deliverEmailDraft } from "@/lib/emails/deliver";
import { redoDraft } from "@/lib/emails/service";
import { deleteBot } from "@/lib/bots/service";
import { notifyHandover } from "@/lib/alerts/notify";
import { startConversation } from "@/lib/conversations/service";
import { addAndRead, hasDb, makeBot, makeUser } from "../helpers/db";
import { fakeMicrosoft, message, TEAMS } from "../helpers/microsoft";

const uid = () => randomUUID().slice(0, 8);

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
    // The first sync asks for the last two days only, not years of mail.
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

    // The team asks for the draft again: Billie replaces its draft, without another post.
    ms.calls.length = 0;
    await redoDraft(admin, rows[0].id);
    const [redo] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "process_email"), sql`${jobs.payload}->>'emailId' = ${rows[0].id}`))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    expect(redo.payload).toEqual({ emailId: rows[0].id, redo: true, replaceDraftId: "draft-1" });
    await processEmail(rows[0].id, { redo: true, replaceDraftId: "draft-1" });
    const [again] = await db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.kind, "deliver_email_draft"), sql`${jobs.payload}->>'emailId' = ${rows[0].id}`),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    expect(again.payload).toEqual({ emailId: rows[0].id, replaceDraftId: "draft-1", quiet: true });
    await deliverEmailDraft(rows[0].id, { replaceDraftId: "draft-1", quiet: true });
    expect(ms.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/messages/draft-1"))).toBe(
      true,
    );
    expect(ms.calls.some((c) => c.url.endsWith("/createReply"))).toBe(true);
    expect(ms.calls.some((c) => c.url.startsWith("https://prod-12."))).toBe(false);
    expect(
      (await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, rows[0].id) }))
        ?.outlookDraftId,
    ).toBe("draft-2");
  });

  it("tells the manager when an email needs a person, with no draft", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const address = `refunds-${uid()}@media-ten.test`;
    await saveMailbox(admin, bot.id, { address, assignedUserId: null, enabled: true });
    await setTeamsLink(admin, bot.id, TEAMS);
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
