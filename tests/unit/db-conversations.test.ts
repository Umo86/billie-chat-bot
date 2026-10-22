import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentPresence, conversations, gaps, jobs, messages } from "@/lib/db/schema";
import {
  conversationForToken,
  handBack,
  handover,
  rateMessage,
  staffReply,
  submitDetails,
  visitorMessage,
  visitorUpdates,
  cleanContact,
} from "@/lib/conversations/service";
import { addAndRead, hasDb, makeBot, makeUser, setAvailableAgent } from "../helpers/db";

async function readyBot() {
  const actor = await makeUser("editor");
  const { bot, kb } = await makeBot();
  await addAndRead(actor, kb.id, {
    kind: "text",
    title: "Exhibitor manual",
    body: "Space-only build-up starts at 08:00 on Sunday 9 May 2027.\n\nDeliveries during build-up go to the hall loading bays.",
  });
  return { bot, actor };
}

describe.skipIf(!hasDb)("conversations (Postgres, stand-in Claude)", () => {
  beforeEach(async () => {
    await db.update(agentPresence).set({ availableUntil: null });
  });

  it("starts a chat, answers from the knowledge with its source, and finds the chat by token", async () => {
    const { bot } = await readyBot();
    const turn = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "When does build-up start?",
    });
    expect(turn.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(turn.status).toBe("bot");
    expect(turn.messages.map((m) => m.role)).toEqual(["visitor", "bot"]);
    expect(turn.messages[1].text).toContain("08:00");
    expect(turn.messages[1].sources).toEqual([{ title: "Exhibitor manual", label: "" }]);
    const found = await conversationForToken(turn.token!, bot.id);
    expect(found?.id).toBe(turn.conversationId);
    expect(
      await conversationForToken(turn.token!, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  it("offers the team when it doesn't know, and records the gap once per wording", async () => {
    const { bot } = await readyBot();
    const t1 = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "Is there a creche?",
    });
    expect(t1.offer).toEqual({ reason: "unknown" });
    const conv = await conversationForToken(t1.token!, bot.id);
    await visitorMessage({ bot, conversation: conv, channel: "web", text: "is there a crèche" });
    const g = await db.query.gaps.findFirst({ where: eq(gaps.botId, bot.id) });
    expect(g).toMatchObject({ askCount: 2, status: "open" });
  });

  it("nobody online: takes details, opens a ticket and queues the alert", async () => {
    const { bot } = await readyBot();
    const t = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "Can I speak to a person please?",
    });
    expect(t.status).toBe("collecting");
    expect(t.form?.fields).toEqual(["name", "company", "stand", "email", "phone"]);
    expect(t.messages.at(-1)?.text).toMatch(/Nobody from the team is online/);

    const bad = cleanContact(bot.rules.collect, { name: "", email: "nope" });
    expect(bad.errors).toMatchObject({ name: expect.any(String), email: expect.any(String) });
    const { contact, errors } = cleanContact(bot.rules.collect, {
      name: "Pat Example",
      email: "pat@example.com",
      stand: "N3-210",
    });
    expect(errors).toEqual({});
    const done = await submitDetails(bot, t.conversationId, contact);
    expect(done.status).toBe("ticket");
    expect(done.messages[0].text).toBe("Thanks, Pat. The team will reply by the next working day.");
    const job = await db.query.jobs.findFirst({
      where: eq(jobs.dedupeKey, `notify:${t.conversationId}:ticket`),
    });
    expect(job?.kind).toBe("notify_handover");
  });

  it("someone online: live chat, staff reply, Billie paused, then handed back", async () => {
    const { bot, actor } = await readyBot();
    await setAvailableAgent(actor.id, true);
    const t = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "I want to talk to a human",
    });
    expect(t.status).toBe("waiting");
    expect(t.messages.at(-1)?.text).toMatch(/Connecting you to the team/);

    await staffReply(actor, t.conversationId, "Hi, Sam here. How can I help?");
    let conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, t.conversationId),
    });
    expect(conv).toMatchObject({ status: "live", assignedTo: actor.id });

    // While a person has the chat, Billie stays quiet.
    const t2 = await visitorMessage({
      bot,
      conversation: conv!,
      channel: "web",
      text: "When does build-up start?",
    });
    expect(t2.messages.map((m) => m.role)).toEqual(["visitor"]);

    const updates = await visitorUpdates(bot, conv!, null);
    expect(updates.messages.find((m) => m.role === "agent")).toMatchObject({
      author: "Sam",
      text: "Hi, Sam here. How can I help?",
    });

    await handBack(actor, t.conversationId);
    conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, t.conversationId),
    });
    expect(conv?.status).toBe("bot");
    const t3 = await visitorMessage({
      bot,
      conversation: conv!,
      channel: "web",
      text: "When does build-up start?",
    });
    expect(t3.messages.at(-1)?.text).toContain("08:00");
  });

  it("always-human topics go straight to the team", async () => {
    const { bot } = await readyBot();
    const t = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "I want a refund for my stand",
    });
    expect(t.status).toBe("collecting");
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, t.conversationId),
    });
    expect(conv?.handoverReason).toBe("always_human");
  });

  it("two thumbs-down in a row offers the team; a thumbs-up resets", async () => {
    const { bot } = await readyBot();
    const t = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "When does build-up start?",
    });
    const conv = (await conversationForToken(t.token!, bot.id))!;
    const t2 = await visitorMessage({
      bot,
      conversation: conv,
      channel: "web",
      text: "Where do deliveries go?",
    });
    const a1 = t.messages[1].id;
    const a2 = t2.messages[1].id;
    expect((await rateMessage(conv.id, a1, -1)).offer).toBeNull();
    expect((await rateMessage(conv.id, a2, 1)).offer).toBeNull();
    expect((await rateMessage(conv.id, a1, -1)).offer).toBeNull();
    expect((await rateMessage(conv.id, a2, -1)).offer).toEqual({ reason: "thumbs_down" });
    const rated = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.role, "bot")));
    expect(rated.map((m) => m.rating).sort()).toEqual([-1, -1]);
  });

  it("WhatsApp out of hours goes straight to a ticket (they already gave their number)", async () => {
    const { bot } = await readyBot();
    const t = await visitorMessage({
      bot,
      conversation: null,
      channel: "whatsapp",
      text: "When does build-up start?",
      waId: "447700900123",
    });
    expect(t.token).toBeUndefined();
    const h = await handover(bot, t.conversationId, "asked_for_person");
    expect(h.status).toBe("ticket");
    expect(h.messages[0].text).toMatch(/They'll reply here by the next working day/);
  });

  it("refuses empty and over-long messages", async () => {
    const { bot } = await readyBot();
    await expect(
      visitorMessage({ bot, conversation: null, channel: "web", text: "   " }),
    ).rejects.toThrow(/Type a message/);
    await expect(
      visitorMessage({ bot, conversation: null, channel: "web", text: "x".repeat(2001) }),
    ).rejects.toThrow(/too long/);
  });
});
