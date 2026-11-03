import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  auditLog,
  botMailboxes,
  botMembers,
  chatRequests,
  conversations,
  emailThreads,
  gaps,
  knowledgeBases,
  sources,
} from "@/lib/db/schema";
import { createBot } from "@/lib/bots/service";
import { botPeople, setBotPeople } from "@/lib/bots/people";
import { assertOnBotOf, botScope, botView, myBotIds, NotOnBotError } from "@/lib/auth/bots";
import { inboxCounts, inboxList } from "@/lib/conversations/inbox";
import { requestList, updateRequest } from "@/lib/requests/service";
import { emailList } from "@/lib/emails/service";
import { knowledgeBaseList, openGaps } from "@/lib/knowledge/queries";
import { navCounts } from "@/lib/shell";
import { agentsAvailable } from "@/lib/conversations/presence";
import { availablePeople, eventManager } from "@/lib/alerts/direct";
import { acceptInvitation, createInvitation } from "@/lib/team/accounts";
import {
  clearPresence,
  hasDb,
  makeBot,
  makeUser,
  putOnBot,
  setAvailableAgent,
} from "../helpers/db";

const uid = () => randomUUID().slice(0, 8);

/** One of everything that belongs to a bot, waiting for a person. */
async function waitingWork(botId: string) {
  const [chat] = await db
    .insert(conversations)
    .values({ botId, channel: "web", status: "waiting", firstQuestion: "Can we build late?" })
    .returning();
  const [request] = await db
    .insert(chatRequests)
    .values({
      botId,
      conversationId: chat.id,
      typeId: "hours",
      typeName: "Extra build-up hours",
      trackToken: randomUUID(),
    })
    .returning();
  const [email] = await db
    .insert(emailThreads)
    .values({
      source: "manual",
      botId,
      fromName: "Sam",
      fromEmail: "sam@stands.test",
      subject: "Build-up",
      body: "When can we build?",
      status: "needs_you",
    })
    .returning();
  const [gap] = await db
    .insert(gaps)
    .values({ botId, questionKey: `q-${uid()}`, question: "Is there Wi-Fi?" })
    .returning();
  return { chat, request, email, gap };
}

describe.skipIf(!hasDb)("people on each bot (Postgres)", () => {
  it("puts whoever makes a bot on it; admins work on every bot", async () => {
    const editor = await makeUser("editor");
    const otherEditor = await makeUser("editor");
    const admin = await makeUser("admin");
    const id = await createBot(editor, {
      name: "Spring Fair Help",
      audience: "exhibitors",
      showName: "Spring Fair 2027",
      color: "#0d6a5b",
      avatarUrl: null,
      welcome: "",
      starters: [],
    });
    expect(await myBotIds(editor)).toContain(id);
    expect(await myBotIds(otherEditor)).not.toContain(id);
    expect(await botScope(admin)).toEqual({ all: true });
  });

  it("lets admins choose who works on a bot, and records it", async () => {
    const admin = await makeUser("admin");
    const editor = await makeUser("editor");
    const agent = await makeUser("agent");
    const { bot } = await makeBot();
    await setBotPeople(admin, bot.id, [editor.id, agent.id, admin.id]);
    let people = await botPeople(bot.id);
    const on = (id: string) => people.find((p) => p.id === id)?.onBot;
    expect([on(editor.id), on(agent.id), on(admin.id)]).toEqual([true, true, true]);
    // Admins aren't members: they're on every bot anyway.
    const rows = await db.select().from(botMembers).where(eq(botMembers.botId, bot.id));
    expect(rows.map((r) => r.userId).sort()).toEqual([editor.id, agent.id].sort());

    await setBotPeople(admin, bot.id, [editor.id]);
    people = await botPeople(bot.id);
    expect([on(editor.id), on(agent.id)]).toEqual([true, false]);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, bot.id));
    expect(audit.map((a) => a.summary)).toContain(
      'Changed who works on "Exhibitor Help": 1 person (0 added, 1 taken off)',
    );
  });

  it("shows people only the chats, requests, emails, gaps and knowledge of their bots", async () => {
    const agent = await makeUser("agent");
    const editor = await makeUser("editor");
    const admin = await makeUser("admin");
    const mine = await makeBot({ name: "Christmas Help" });
    const theirs = await makeBot({ name: "Spring Help" });
    await putOnBot(mine.bot.id, agent.id, editor.id);
    const a = await waitingWork(mine.bot.id);
    const b = await waitingWork(theirs.bot.id);

    const view = await botView(agent);
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    expect(ids(await inboxList("needs", view))).toContain(a.chat.id);
    expect(ids(await inboxList("needs", view))).not.toContain(b.chat.id);
    expect(ids(await requestList("new", view))).toContain(a.request.id);
    expect(ids(await requestList("new", view))).not.toContain(b.request.id);
    expect(ids(await emailList("check", view))).toContain(a.email.id);
    expect(ids(await emailList("check", view))).not.toContain(b.email.id);
    expect((await inboxCounts(view)).needs).toBe(1);
    expect(await navCounts(agent)).toMatchObject({ inbox: 1, requests: 1, emails: 1 });

    const editorIds = await myBotIds(editor);
    expect(ids(await openGaps(editorIds))).toContain(a.gap.id);
    expect(ids(await openGaps(editorIds))).not.toContain(b.gap.id);
    expect(ids(await knowledgeBaseList(editorIds))).toEqual([mine.kb.id]);

    // An admin sees both, and can look at one bot at a time.
    const all = await botView(admin);
    expect(ids(await inboxList("needs", all))).toEqual(
      expect.arrayContaining([a.chat.id, b.chat.id]),
    );
    const one = await botView(admin, theirs.bot.id);
    expect(ids(await inboxList("needs", one))).toContain(b.chat.id);
    expect(ids(await inboxList("needs", one))).not.toContain(a.chat.id);
    // Picking a bot you don't work on shows your own bots, not theirs.
    expect((await botView(agent, theirs.bot.id)).only).toBeNull();
  });

  it("refuses changes to anything of a bot someone doesn't work on", async () => {
    const agent = await makeUser("agent");
    const editor = await makeUser("editor");
    const admin = await makeUser("admin");
    const mine = await makeBot();
    const theirs = await makeBot();
    await putOnBot(mine.bot.id, agent.id, editor.id);
    const a = await waitingWork(mine.bot.id);
    const b = await waitingWork(theirs.bot.id);
    const [source] = await db
      .insert(sources)
      .values({ knowledgeBaseId: theirs.kb.id, kind: "text", title: "Hours", body: "9 to 5." })
      .returning();

    await expect(
      assertOnBotOf(agent, "inbox.reply", "conversation", a.chat.id),
    ).resolves.toBeUndefined();
    await expect(assertOnBotOf(agent, "inbox.reply", "conversation", b.chat.id)).rejects.toThrow(
      NotOnBotError,
    );
    await expect(assertOnBotOf(agent, "inbox.reply", "request", b.request.id)).rejects.toThrow(
      /don't work on this bot/,
    );
    await expect(assertOnBotOf(agent, "emails.handle", "email", b.email.id)).rejects.toThrow(
      NotOnBotError,
    );
    await expect(assertOnBotOf(editor, "knowledge.edit", "source", source.id)).rejects.toThrow(
      NotOnBotError,
    );
    await expect(assertOnBotOf(editor, "knowledge.edit", "gap", b.gap.id)).rejects.toThrow(
      NotOnBotError,
    );
    // An agent can't change knowledge, even on their own bot.
    await expect(assertOnBotOf(agent, "knowledge.edit", "kb", mine.kb.id)).rejects.toThrow(
      NotOnBotError,
    );
    // An old shared base with no bot: admins only.
    const [old] = await db.insert(knowledgeBases).values({ name: "Old FAQ" }).returning();
    await expect(assertOnBotOf(editor, "knowledge.edit", "kb", old.id)).rejects.toThrow(
      NotOnBotError,
    );
    await expect(assertOnBotOf(admin, "knowledge.edit", "kb", old.id)).resolves.toBeUndefined();
    await expect(
      assertOnBotOf(admin, "inbox.reply", "conversation", b.chat.id),
    ).resolves.toBeUndefined();
  });

  it("gives requests only to people on the bot", async () => {
    const admin = await makeUser("admin");
    const onBot = await makeUser("agent");
    const offBot = await makeUser("agent");
    const { bot } = await makeBot();
    await putOnBot(bot.id, onBot.id);
    const { request } = await waitingWork(bot.id);
    await expect(updateRequest(admin, request.id, { assignedTo: offBot.id })).rejects.toThrow(
      /don't work on this bot/,
    );
    await updateRequest(admin, request.id, { assignedTo: onBot.id });
    expect(
      (await db.query.chatRequests.findFirst({ where: eq(chatRequests.id, request.id) }))
        ?.assignedTo,
    ).toBe(onBot.id);
  });

  it("sends live chats and Teams messages only to people on the bot", async () => {
    const onBot = await makeUser("agent");
    const offBot = await makeUser("agent");
    const { bot } = await makeBot();
    await putOnBot(bot.id, onBot.id);
    await clearPresence();
    await setAvailableAgent(offBot.id, true);
    // Someone is available, but not for this bot: the visitor is asked for details instead.
    expect(await agentsAvailable(new Date(), bot.id)).toBe(0);
    expect(await availablePeople(bot.id)).toEqual([]);
    await setAvailableAgent(onBot.id, true);
    expect(await agentsAvailable(new Date(), bot.id)).toBe(1);
    expect(await availablePeople(bot.id)).toEqual([{ email: onBot.email }]);

    // A mailbox manager taken off the bot gets no more messages about it.
    await db.insert(botMailboxes).values({
      botId: bot.id,
      address: `ppl-${uid()}@media-ten.test`,
      assignedUserId: offBot.id,
    });
    expect(await eventManager(bot.id)).toEqual([]);
    await db
      .update(botMailboxes)
      .set({ assignedUserId: onBot.id })
      .where(eq(botMailboxes.botId, bot.id));
    expect(await eventManager(bot.id)).toEqual([{ email: onBot.email }]);
    await clearPresence();
  });

  it("puts an invited person on the bots chosen for them when they join", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const { bot: binned } = await makeBot();
    const email = `new-${uid()}@media10.test`;
    const { link } = await createInvitation(admin, {
      email,
      name: "Jo Agent",
      role: "agent",
      botIds: [bot.id, binned.id, randomUUID()],
    });
    const { bots } = await import("@/lib/db/schema");
    await db.update(bots).set({ deletedAt: new Date() }).where(eq(bots.id, binned.id));
    const id = await acceptInvitation(
      link.split("/invite/")[1],
      { id: randomUUID(), email, name: "Jo Agent" },
      new Date(),
    );
    const rows = await db.select().from(botMembers).where(eq(botMembers.userId, id));
    expect(rows.map((r) => r.botId)).toEqual([bot.id]);
  });
});
