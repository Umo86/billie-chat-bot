import { describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { conversations, jobs, messages } from "@/lib/db/schema";
import { handover, startConversation, visitorMessage } from "@/lib/conversations/service";
import { writeSuggestion } from "@/lib/conversations/suggest";
import { botById } from "@/lib/bots/load";
import { addAndRead, hasDb, makeBot, makeUser } from "../helpers/db";

async function suggestionOf(id: string) {
  return (await db.query.conversations.findFirst({ where: eq(conversations.id, id) }))?.suggestion;
}

describe.skipIf(!hasDb)("suggested replies in the Inbox (Postgres, stand-in Claude)", () => {
  it("drafts a reply from the knowledge when a chat is handed to the team", async () => {
    const editor = await makeUser("editor");
    const { bot, kb } = await makeBot();
    await addAndRead(editor, kb.id, {
      kind: "text",
      title: "Deliveries",
      body: "Deliveries during build-up go to the hall loading bays at Gate B.",
    });
    const turn = await visitorMessage({
      bot,
      conversation: null,
      channel: "web",
      text: "Where do deliveries go during build-up? I'd like to speak to a person.",
    });
    const id = turn.conversationId;
    const fresh = (await botById(bot.id))!;
    await handover(fresh, id, "asked_for_person");
    // Waiting to be written, on the queue.
    expect((await suggestionOf(id))?.status).toBe("writing");
    const queued = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "suggest_reply"), like(jobs.dedupeKey, `suggest:${id}:%`)));
    expect(queued).toHaveLength(1);

    await writeSuggestion(id);
    const s = await suggestionOf(id);
    expect(s).toMatchObject({ status: "ready", confident: true });
    expect(s?.text).toContain("Gate B");
    expect(s?.sources).toEqual([{ title: "Deliveries", label: "" }]);
    const [asked] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.role, "visitor")));
    expect(s?.afterMessageId).toBe(asked.id);
  });

  it("suggests a holding reply when the knowledge doesn't cover it", async () => {
    const { bot } = await makeBot();
    const { conversation } = await startConversation({ bot, channel: "web" });
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "visitor",
      text: "Can we bring a pet tortoise on the stand?",
    });
    await writeSuggestion(conversation.id);
    const s = await suggestionOf(conversation.id);
    expect(s).toMatchObject({ status: "ready", confident: false, sources: [] });
    expect(s?.text).toMatch(/checking this/);
    expect(s?.missing).toContain("tortoise");
  });

  it("says so when there's nothing to answer yet", async () => {
    const { bot } = await makeBot();
    const { conversation } = await startConversation({ bot, channel: "web" });
    await writeSuggestion(conversation.id);
    expect(await suggestionOf(conversation.id)).toMatchObject({
      status: "failed",
      error: "They haven't asked anything yet.",
    });
  });
});
