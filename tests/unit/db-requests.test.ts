import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  auditLog,
  bots,
  chatRequests,
  conversations,
  jobs,
  messages,
  settings,
} from "@/lib/db/schema";
import {
  requestOffered,
  startConversation,
  submitRequest,
  visitorMessage,
  visitorUpdates,
} from "@/lib/conversations/service";
import { botById } from "@/lib/bots/load";
import { saveMailbox } from "@/lib/emails/mailboxes";
import { setDirectLink } from "@/lib/alerts/direct";
import {
  notifyRequest,
  requestByToken,
  requestDetail,
  requestList,
  updateRequest,
} from "@/lib/requests/service";
import { deletePerson, findPerson } from "@/lib/privacy/requests";
import { runRetention } from "@/lib/privacy/retention";
import type { RequestType } from "@/lib/types";
import { appUrl } from "@/lib/config";
import { hasDb, makeBot, makeUser } from "../helpers/db";
import { DIRECT } from "../helpers/microsoft";

const hours: RequestType = {
  id: "hours001",
  name: "Extra build-up or breakdown hours",
  when: "They need to work outside the published build-up hours.",
  handlerId: null,
  fields: [{ id: "when0001", label: "Which days and times", kind: "long", required: true }],
};

async function botWithRequests() {
  const admin = await makeUser("admin");
  const manager = await makeUser("agent");
  const { bot } = await makeBot();
  await db
    .update(bots)
    .set({ requestTypes: [hours] })
    .where(eq(bots.id, bot.id));
  await saveMailbox(admin, bot.id, {
    address: `req-${randomUUID().slice(0, 8)}@media-ten.test`,
    assignedUserId: manager.id,
    enabled: false,
  });
  return { admin, manager, bot: (await botById(bot.id))! };
}

describe.skipIf(!hasDb)("requests from chat (Postgres, stand-in Claude)", () => {
  beforeAll(async () => {
    const admin = await makeUser("admin");
    await setDirectLink(admin, DIRECT);
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });
  afterAll(async () => {
    await db.update(settings).set({ teamsDmWebhookUrl: null });
  });

  it("offers the form on the web, never on WhatsApp", async () => {
    const { bot } = await botWithRequests();
    const web = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "We need extra hours on Wednesday evening. Can we book them?",
    });
    expect(web.request).toMatchObject({ typeId: "hours001", name: hours.name });
    expect(web.offer).toBeNull(); // a request isn't a reason to hand over
    const wa = await visitorMessage({
      bot,
      conversation: null,
      channel: "whatsapp",
      waId: `44${Date.now()}`.slice(0, 12),
      text: "We need extra hours on Wednesday evening. Can we book them?",
    });
    expect(wa.request).toBeNull();

    // The form comes back when the chat is opened again, until something else is said.
    const chat = (await db.query.conversations.findFirst({
      where: eq(conversations.id, web.conversationId),
    }))!;
    expect((await visitorUpdates(bot, chat, null)).request).toMatchObject({ typeId: "hours001" });
    expect(await requestOffered(chat.id, "hours001")).toBe(true);
    expect(await requestOffered(chat.id, "other001")).toBe(false);
    await visitorMessage({ bot, conversation: chat, channel: "web", text: "Thanks, bye" });
    expect((await visitorUpdates(bot, chat, null)).request).toBeNull();
  });

  it("saves a request once, tells the person how to follow it and the team in Teams", async () => {
    const { bot, manager } = await botWithRequests();
    const { conversation } = await startConversation({ bot, channel: "web" });
    const answers = [{ label: "Which days and times", value: "Wednesday 25 November until 22:00" }];
    const contact = {
      name: "Sam Lee",
      company: "Acme Stands",
      stand: "N3-210",
      email: "sam@acme.test",
    };
    const turn = await submitRequest(bot, conversation.id, hours, answers, contact);
    const [req] = await db
      .select()
      .from(chatRequests)
      .where(eq(chatRequests.conversationId, conversation.id));
    expect(req).toMatchObject({
      typeName: hours.name,
      status: "new",
      assignedTo: manager.id, // whoever manages the event mailbox
      answers,
      contact,
    });
    expect(req.ref).toBeGreaterThanOrEqual(1001);
    expect(turn.messages[0].text).toBe(
      `Thanks, Sam. Your request R-${req.ref} (${hours.name}) is with the team. Follow it here: ${appUrl()}/r/${req.trackToken}`,
    );
    const chat = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(chat?.contact).toMatchObject({ name: "Sam Lee", company: "Acme Stands" });
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, req.id));
    expect(audit.map((a) => a.summary)).toEqual([
      `New request R-${req.ref} (${hours.name}) in a chat with ${bot.name}`,
    ]);

    // Pressing Send again doesn't make a second request.
    const again = await submitRequest(bot, conversation.id, hours, answers, contact);
    expect(again.messages[0].text).toBe(`Your request R-${req.ref} is already with the team.`);
    expect(
      await db.select().from(chatRequests).where(eq(chatRequests.conversationId, conversation.id)),
    ).toHaveLength(1);

    // The team: a Teams message to whoever handles it, queued once.
    const queued = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "notify_request"), eq(jobs.dedupeKey, `notify-request:${req.id}`)));
    expect(queued).toHaveLength(1);
    await notifyRequest(req.id);
    await notifyRequest(req.id); // a retry
    const dms = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "teams_direct"), like(jobs.dedupeKey, `dm:request:${req.id}:%`)));
    expect(dms.map((j) => (j.payload as { to: string }).to)).toEqual([manager.email]);
    expect(JSON.stringify(dms[0].payload)).toContain("a new request");
  });

  it("handles it: status, owner and a message the person sees, emailed when email is set up", async () => {
    const { bot, admin } = await botWithRequests();
    const { conversation } = await startConversation({ bot, channel: "web" });
    await submitRequest(
      bot,
      conversation.id,
      hours,
      [{ label: "Which days and times", value: "2026-11-25" }],
      { name: "Jo Patel", email: "jo@stands.test", phone: "07700 900123" },
    );
    const [req] = await db
      .select()
      .from(chatRequests)
      .where(eq(chatRequests.conversationId, conversation.id));
    expect((await requestList("new")).map((r) => r.id)).toContain(req.id);

    process.env.RESEND_API_KEY = "re_test_not_real";
    process.env.EMAIL_FROM = "Billie <billie@media10.test>";
    await updateRequest(admin, req.id, {
      status: "done",
      note: "Approved: build until 22:00 on Wednesday.",
      assignedTo: admin.id,
    });
    const row = await db.query.chatRequests.findFirst({ where: eq(chatRequests.id, req.id) });
    expect(row).toMatchObject({ status: "done", assignedTo: admin.id });
    expect(row?.closedAt).toBeInstanceOf(Date);
    expect((await requestList("finished")).map((r) => r.id)).toContain(req.id);
    const emails = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, "send_request_update"),
          like(jobs.dedupeKey, `request-update:${req.id}:%`),
        ),
      );
    expect(emails).toHaveLength(1);
    // Saving the same thing again emails nobody.
    await updateRequest(admin, req.id, {
      status: "done",
      note: "Approved: build until 22:00 on Wednesday.",
    });
    const updates = () =>
      db
        .select()
        .from(jobs)
        .where(like(jobs.dedupeKey, `request-update:${req.id}:%`))
        .orderBy(jobs.createdAt);
    expect(await updates()).toHaveLength(1);
    // Every real change is emailed, as it was then: reopened, then done again.
    await updateRequest(admin, req.id, { status: "in_progress" });
    await updateRequest(admin, req.id, { status: "done" });
    expect((await updates()).map((j) => (j.payload as { status: string }).status)).toEqual([
      "done",
      "in_progress",
      "done",
    ]);
    // A screen that read an older version can't save over a newer one.
    const seen = (await requestDetail(req.id))!.updatedAt;
    await updateRequest(admin, req.id, { note: "Approved until 22:30." });
    await expect(updateRequest(admin, req.id, { status: "new" }, seen)).rejects.toThrow(
      /Someone else changed this request/,
    );

    const detail = await requestDetail(req.id);
    expect(detail?.answers).toEqual([
      { label: "Which days and times", value: "Wednesday 25 November 2026" },
    ]);
    expect(detail?.history.map((h) => h.what)).toEqual([
      `New request R-${req.ref} (${hours.name}) in a chat with ${bot.name}`,
      `Gave R-${req.ref} to Sam Tester, updated the message on R-${req.ref}, marked R-${req.ref} as done`,
      `Marked R-${req.ref} as in progress`,
      `Marked R-${req.ref} as done`,
      `Updated the message on R-${req.ref}`,
    ]);

    // The person's page: their request and the team's message, never their email or phone.
    const page = await requestByToken(req.trackToken);
    expect(page).toMatchObject({
      ref: `R-${req.ref}`,
      status: "done",
      statusText: "Your request is done.",
      note: "Approved until 22:30.",
    });
    expect(JSON.stringify(page)).not.toContain("jo@stands.test");
    expect(JSON.stringify(page)).not.toContain("07700");
    expect(await requestByToken("not-a-real-token-at-all-xx")).toBeNull();
  });

  it("marks requests from test chats, and messages nobody about them", async () => {
    const { bot, admin } = await botWithRequests();
    const { conversation } = await startConversation({ bot, channel: "try" });
    await submitRequest(bot, conversation.id, hours, [{ label: "When", value: "Friday" }], {
      name: "Tester",
      email: "tester@media10.test",
    });
    const [req] = await db
      .select()
      .from(chatRequests)
      .where(eq(chatRequests.conversationId, conversation.id));
    expect((await requestList("new")).find((r) => r.id === req.id)?.test).toBe(true);
    expect((await requestDetail(req.id))?.test).toBe(true);
    await notifyRequest(req.id);
    expect(
      await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, "teams_direct"), like(jobs.dedupeKey, `dm:request:${req.id}:%`))),
    ).toHaveLength(0);
    // Nor emails, even with email set up.
    process.env.RESEND_API_KEY = "re_test_not_real";
    process.env.EMAIL_FROM = "Billie <billie@media10.test>";
    await updateRequest(admin, req.id, { status: "done", note: "Test done." });
    expect(
      await db
        .select()
        .from(jobs)
        .where(like(jobs.dedupeKey, `request-update:${req.id}:%`)),
    ).toHaveLength(0);
  });

  it("is found, copied and deleted with the rest of a person's data", async () => {
    const { bot, admin } = await botWithRequests();
    const { conversation } = await startConversation({ bot, channel: "web" });
    const email = `kim-${randomUUID().slice(0, 6)}@stands.test`;
    await submitRequest(
      bot,
      conversation.id,
      hours,
      [{ label: "Which days and times", value: "Tuesday" }],
      { name: "Kim", email },
    );
    expect(await findPerson(email)).toMatchObject({ requests: 1 });
    expect(await deletePerson(admin, email)).toMatchObject({ requests: 1 });
    expect(await findPerson(email)).toMatchObject({ requests: 0, chats: 0 });
    // Messages went with the chat.
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, conversation.id)),
    ).toHaveLength(0);
  });

  it("goes after the retention period, like chats and emails", async () => {
    const { bot } = await botWithRequests();
    const { conversation } = await startConversation({ bot, channel: "web" });
    await submitRequest(bot, conversation.id, hours, [{ label: "When", value: "Monday" }], {
      name: "Old",
      email: "old@stands.test",
    });
    const old = new Date();
    old.setMonth(old.getMonth() - 13);
    await db
      .update(chatRequests)
      .set({ updatedAt: old })
      .where(eq(chatRequests.conversationId, conversation.id));
    const counts = await runRetention();
    expect(counts.requests).toBeGreaterThanOrEqual(1);
    expect(
      await db.select().from(chatRequests).where(eq(chatRequests.conversationId, conversation.id)),
    ).toHaveLength(0);
  });
});
