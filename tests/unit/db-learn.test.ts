import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { emailThreads, jobs, sources } from "@/lib/db/schema";
import {
  checkSentDrafts,
  dismissLearning,
  learnFromSent,
  learningOffers,
  saveLearning,
  sentCounts,
} from "@/lib/emails/learn";
import { hasDb, makeBot, makeUser } from "../helpers/db";
import { fakeMicrosoft } from "../helpers/microsoft";

const DRAFT =
  "Hi Sam,\n\nSpace only build-up starts on Tuesday 24 November at 10:30.\n\nKind regards,\nThe team";

describe.skipIf(!hasDb)("learning from what the team sends (Postgres, stand-in Outlook)", () => {
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

  async function outlookEmail(
    botId: string,
    draftId: string,
    subject = "When does build-up start",
  ) {
    const [e] = await db
      .insert(emailThreads)
      .values({
        source: "outlook",
        botId,
        mailbox: "ihs@media-ten.test",
        externalId: `msg-${randomUUID()}`,
        fromName: "Sam Lee",
        fromEmail: "sam@stands.test",
        subject,
        body: "When does space only build-up start?",
        status: "draft_ready",
        draft: DRAFT,
        outlookDraftId: draftId,
      })
      .returning();
    return e;
  }

  it("counts drafts sent unchanged, and offers a corrected fact as a typed answer", async () => {
    const editor = await makeUser("editor");
    const { bot, kb } = await makeBot();
    const waiting = await outlookEmail(bot.id, `d-wait-${randomUUID()}`);
    const same = await outlookEmail(bot.id, `d-same-${randomUUID()}`);
    const changed = await outlookEmail(bot.id, `d-changed-${randomUUID()}`);
    const binned = await outlookEmail(bot.id, `d-gone-${randomUUID()}`);
    const reworded = await outlookEmail(bot.id, `d-reword-${randomUUID()}`);
    const sent = new Map<string, { isDraft: boolean; text: string } | "gone">([
      [waiting.outlookDraftId!, { isDraft: true, text: DRAFT }],
      [
        reworded.outlookDraftId!,
        { isDraft: false, text: DRAFT.replace("Hi Sam,", "Hello Sam,").replace("Kind", "Best") },
      ],
      [same.outlookDraftId!, { isDraft: false, text: `${DRAFT}\n\n________________\nFrom: Sam` }],
      [changed.outlookDraftId!, { isDraft: false, text: DRAFT.replace("10:30", "12:00") }],
      [binned.outlookDraftId!, "gone"],
    ]);
    vi.stubGlobal("fetch", fakeMicrosoft({}, { sent }).fetchMock);

    // Other tests' Outlook emails may be looked at too: count only this bot's below.
    expect(await checkSentDrafts(new Date())).toBeGreaterThanOrEqual(3);
    const row = async (id: string) =>
      db.query.emailThreads.findFirst({ where: eq(emailThreads.id, id) });
    expect(await row(waiting.id)).toMatchObject({ status: "draft_ready", sentOutcome: null });
    expect(await row(same.id)).toMatchObject({ status: "sent", sentOutcome: "unchanged" });
    expect(await row(changed.id)).toMatchObject({ status: "sent", sentOutcome: "edited" });
    expect((await row(changed.id))?.sentText).toContain("12:00");
    expect(await row(binned.id)).toMatchObject({ status: "draft_ready", sentOutcome: "discarded" });
    expect(await sentCounts(new Date("2026-11-01T00:00:00Z"), [bot.id])).toEqual({
      unchanged: 1,
      edited: 2,
    });
    // Only a greeting and sign-off reworded: no fact to learn, so no Claude call for it.
    expect(
      await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, "learn_from_sent"), eq(jobs.dedupeKey, `learn:${reworded.id}`))),
    ).toHaveLength(0);

    // The changed one: Billie works out what the team corrected, on the queue.
    const [learn] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "learn_from_sent"), eq(jobs.dedupeKey, `learn:${changed.id}`)));
    expect(learn).toBeTruthy();
    await learnFromSent(changed.id);
    const [offer] = (await learningOffers([bot.id])).filter((o) => o.emailId === changed.id);
    expect(offer.learning).toMatchObject({
      status: "offered",
      question: "When does build-up start?",
    });
    expect(offer.learning.answer).toContain("12:00");
    // Nothing for someone who doesn't work on the bot.
    expect(await learningOffers([])).toEqual([]);

    // Saved as the person edited it: a typed answer in that bot's knowledge.
    await saveLearning(editor, changed.id, {
      question: "When does space only build-up start?",
      answer: "Tuesday 24 November from 12:00.",
    });
    const saved = await db
      .select()
      .from(sources)
      .where(and(eq(sources.knowledgeBaseId, kb.id), eq(sources.kind, "qa")));
    expect(saved.map((s) => s.title)).toEqual(["When does space only build-up start?"]);
    expect((await row(changed.id))?.learning?.status).toBe("saved");
    await expect(saveLearning(editor, changed.id, { question: "x?", answer: "y" })).rejects.toThrow(
      /no longer waiting/,
    );
  });

  it("offers nothing when only the wording changed, and can be dismissed", async () => {
    const editor = await makeUser("editor");
    const { bot } = await makeBot();
    const wording = await outlookEmail(bot.id, `d-word-${randomUUID()}`);
    const fact = await outlookEmail(bot.id, `d-fact-${randomUUID()}`, "Electrics deadline");
    const sent = new Map([
      [wording.outlookDraftId!, { isDraft: false, text: DRAFT.replace("Hi Sam", "Dear Sam") }],
      [fact.outlookDraftId!, { isDraft: false, text: DRAFT.replace("24 November", "25 November") }],
    ]);
    vi.stubGlobal("fetch", fakeMicrosoft({}, { sent }).fetchMock);
    await checkSentDrafts(new Date());
    await learnFromSent(wording.id);
    await learnFromSent(fact.id);
    const offers = await learningOffers([bot.id]);
    expect(offers.map((o) => o.emailId)).toEqual([fact.id]);
    await dismissLearning(editor, fact.id);
    expect(await learningOffers([bot.id])).toEqual([]);
  });
});
