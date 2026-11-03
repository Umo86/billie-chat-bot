import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { emailSuggestions, sources } from "@/lib/db/schema";
import {
  dismissSuggestions,
  emailSuggestionsFor,
  historyState,
  readHistory,
  saveSuggestion,
  startHistory,
} from "@/lib/emails/history";
import { saveMailbox } from "@/lib/emails/mailboxes";
import { hasDb, makeBot, makeUser } from "../helpers/db";
import { fakeMicrosoft } from "../helpers/microsoft";

const graphMessage = (
  conversationId: string,
  from: string,
  at: string,
  subject: string,
  text: string,
  sent = false,
) => ({
  id: randomUUID(),
  conversationId,
  subject,
  isDraft: false,
  ...(sent ? { sentDateTime: at } : { receivedDateTime: at }),
  from: { emailAddress: { address: from } },
  uniqueBody: { contentType: "text", content: text },
});

describe.skipIf(!hasDb)("learning from past emails (Postgres, stand-in Microsoft)", () => {
  beforeAll(() => {
    process.env.MS_TENANT_ID = "tenant-test";
    process.env.MS_CLIENT_ID = "client-test";
    process.env.MS_CLIENT_SECRET = "not-a-real-secret";
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => {
    delete process.env.MS_TENANT_ID;
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
  });

  it("finds the questions asked most, with the team's answers, to check and save", async () => {
    const admin = await makeUser("admin");
    const { bot, kb } = await makeBot({ name: "History Bot" });
    const box = `history-${randomUUID().slice(0, 6)}@media-ten.test`;
    await saveMailbox(admin, bot.id, { address: box, assignedUserId: null, enabled: true });
    const day = (d: number, h = 9) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
    const ms = fakeMicrosoft(
      {},
      {
        history: {
          [box]: {
            inbound: [
              graphMessage(
                "c1",
                "sam@acme.test",
                day(1),
                "Badge collection",
                "When can we collect our badges?",
              ),
              graphMessage(
                "c2",
                "jo@bolt.test",
                day(2),
                "Badge collection",
                "Hi, when are badges ready to collect?",
              ),
              graphMessage(
                "c3",
                "kim@kite.test",
                day(3),
                "Parking",
                "Where can our van park on build-up day?",
              ),
            ],
            sent: [
              graphMessage(
                "c1",
                box,
                day(1, 12),
                "RE: Badge collection",
                "Badges are at the north entrance from 8am.",
                true,
              ),
              graphMessage(
                "c2",
                box,
                day(2, 12),
                "RE: Badge collection",
                "Collect them at the north entrance from 8am.",
                true,
              ),
              graphMessage(
                "c3",
                box,
                day(3, 12),
                "RE: Parking",
                "Vans park in car park B during build-up.",
                true,
              ),
            ],
          },
        },
      },
    );
    vi.stubGlobal("fetch", ms.fetchMock);

    await startHistory(admin, bot.id, 12);
    await expect(startHistory(admin, bot.id, 12)).rejects.toThrow(/already reading/);
    expect((await historyState(bot.id)).status).toBe("reading");
    await readHistory(bot.id, 12, { now: new Date(Date.UTC(2026, 10, 3)) });
    // Read only: nothing was written to the mailbox.
    expect(ms.calls.filter((c) => c.method !== "GET" && !c.url.includes("login."))).toEqual([]);

    const offered = await emailSuggestionsFor([bot.id]);
    expect(offered).toEqual([
      expect.objectContaining({
        question: "Badge collection?",
        // The newest reply's answer: the most up to date.
        answer: "Collect them at the north entrance from 8am.",
        count: 2,
      }),
    ]);
    expect(await historyState(bot.id)).toMatchObject({
      status: "done",
      note: "Read 3 replies: 1 question to check on the Knowledge page.",
      waiting: 1,
    });
    // Nobody else's bot shows them.
    const other = await makeBot();
    expect(await emailSuggestionsFor([other.bot.id])).toEqual([]);

    // Saved (as the person edited it): a typed answer in the bot's own knowledge.
    await saveSuggestion(admin, offered[0].id, {
      question: "When can we collect our badges?",
      answer: "From 8am at the north entrance. Bring photo ID.",
    });
    const typed = await db.query.sources.findFirst({
      where: and(eq(sources.knowledgeBaseId, kb.id), eq(sources.kind, "qa")),
    });
    expect(typed?.body).toContain("Bring photo ID");
    await expect(
      saveSuggestion(admin, offered[0].id, { question: "x?", answer: "y" }),
    ).rejects.toThrow(/no longer waiting/);

    // Read again: what's saved isn't offered again; dismissing clears the rest.
    await db
      .update(emailSuggestions)
      .set({ status: "saved" })
      .where(eq(emailSuggestions.botId, bot.id));
    await readHistory(bot.id, 12, { now: new Date(Date.UTC(2026, 10, 3)) });
    const again = await emailSuggestionsFor([bot.id]);
    expect(again.map((s) => s.question)).not.toContain("Badge collection?");
    await dismissSuggestions(
      admin,
      again.map((s) => s.id),
    );
    expect(await emailSuggestionsFor([bot.id])).toEqual([]);
  });

  it("says so when the mailbox has no replies to learn from", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const box = `empty-${randomUUID().slice(0, 6)}@media-ten.test`;
    await saveMailbox(admin, bot.id, { address: box, assignedUserId: null, enabled: true });
    vi.stubGlobal(
      "fetch",
      fakeMicrosoft({}, { history: { [box]: { sent: [], inbound: [] } } }).fetchMock,
    );
    await startHistory(admin, bot.id, 3);
    await readHistory(bot.id, 3);
    expect((await historyState(bot.id)).note).toMatch(/No replies found/);
  });
});
