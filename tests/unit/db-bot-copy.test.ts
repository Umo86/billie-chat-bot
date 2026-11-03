import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botMailboxes, botMembers, bots, knowledgeBases, passages, sources } from "@/lib/db/schema";
import { copyBot, datesToCheck, markDatesChecked } from "@/lib/bots/copy";
import { answerBotFor, botById } from "@/lib/bots/load";
import { retrieve } from "@/lib/knowledge/search";
import { addAndRead, hasDb, makeBot, makeUser, putOnBot } from "../helpers/db";

describe.skipIf(!hasDb)("copying a bot for the next show (Postgres)", () => {
  it("copies the bot, its people and all its knowledge, but not the show's own settings", async () => {
    const editor = await makeUser("editor");
    const agent = await makeUser("agent");
    const { bot, kb } = await makeBot({ name: "Christmas 2026 Help" });
    await putOnBot(bot.id, editor.id, agent.id);
    await db
      .update(bots)
      .set({
        welcome: "Welcome to Ideal Home Show Christmas 2026.",
        starters: ["When can we build?"],
        pageStarters: [{ match: "/deliveries", starters: ["When can we unload?"] }],
        showStartsOn: "2026-11-20",
        showEndsOn: "2026-12-06",
        domains: ["idealhomeshowchristmas.co.uk"],
        tests: [{ id: "t1", question: "When does build-up start?", mustMention: "24 November" }],
        lastTestRun: { at: new Date().toISOString(), passed: 1, total: 1, results: [] },
        status: "live",
      })
      .where(eq(bots.id, bot.id));
    await db
      .insert(botMailboxes)
      .values({ botId: bot.id, address: `xmas-${bot.id.slice(0, 6)}@media-ten.test` });
    await addAndRead(editor, kb.id, {
      kind: "text",
      title: "Show timetable",
      body: "Space only build-up starts on Tuesday 24 November 2026 at 10:30.",
    });
    const gone = await addAndRead(editor, kb.id, { kind: "text", title: "Old", body: "Removed." });
    await db.update(sources).set({ deletedAt: new Date() }).where(eq(sources.id, gone));

    const id = await copyBot(editor, bot.id, {
      name: "Christmas 2027 Help",
      showName: "Ideal Home Show Christmas 2027",
    });
    const copy = (await botById(id))!;
    expect(copy).toMatchObject({
      name: "Christmas 2027 Help",
      showName: "Ideal Home Show Christmas 2027",
      status: "draft",
      domains: [],
      lastTestRun: null,
      welcome: "Welcome to Ideal Home Show Christmas 2026.",
      pageStarters: [{ match: "/deliveries", starters: ["When can we unload?"] }],
      // Each show has its own days.
      showStartsOn: null,
      showEndsOn: null,
      copiedFromId: bot.id,
      datesCheckedAt: null,
    });
    expect(copy.tests).toHaveLength(1);
    expect(copy.slug).not.toBe(bot.slug);
    expect(await db.select().from(botMailboxes).where(eq(botMailboxes.botId, id))).toHaveLength(0);
    const members = await db.select().from(botMembers).where(eq(botMembers.botId, id));
    expect(members.map((m) => m.userId).sort()).toEqual([editor.id, agent.id].sort());

    // Its own knowledge, passages and all, answering straight away; the deleted source stays behind.
    const ids = (await answerBotFor(copy)).knowledgeBaseIds;
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(kb.id);
    const copied = await db.select().from(sources).where(eq(sources.knowledgeBaseId, ids[0]));
    expect(copied.map((s) => [s.title, s.status, s.passageCount])).toEqual([
      ["Show timetable", "ready", 1],
    ]);
    const found = await retrieve(ids, "When does build-up start?");
    expect(found.map((p) => p.text)).toEqual([
      "Space only build-up starts on Tuesday 24 November 2026 at 10:30.",
    ]);
    // Changing the copy leaves the original alone.
    await db.delete(passages).where(eq(passages.knowledgeBaseId, ids[0]));
    expect((await retrieve([kb.id], "When does build-up start?")).length).toBe(1);
    expect(
      await db.query.knowledgeBases.findFirst({ where: and(eq(knowledgeBases.botId, id)) }),
    ).toMatchObject({ name: "Christmas 2027 Help" });
  });

  it("lists every date to check until someone says they're checked", async () => {
    const editor = await makeUser("editor");
    const { bot, kb } = await makeBot({ name: "Spring Help" });
    await db
      .update(bots)
      .set({ welcome: "Welcome to Spring Fair 2026." })
      .where(eq(bots.id, bot.id));
    const id = await addAndRead(editor, kb.id, {
      kind: "text",
      title: "Deadlines",
      body: "Stand plans by 9 January 2026. Electrics by 16 January 2026. Stand plans by 9 January 2026.",
    });
    const copyId = await copyBot(editor, bot.id, { name: "Spring Help 2027", showName: "" });
    const groups = await datesToCheck(copyId);
    expect(groups.map((g) => [g.kind, g.title, g.dates.map((d) => d.text)])).toEqual([
      ["bot", "The bot's own words", ["2026"]],
      ["source", "Deadlines", ["9 January 2026", "16 January 2026"]],
    ]);
    expect(groups[1].id).not.toBe(id); // the copy's own source
    expect(groups[0].dates[0].snippet).toBe("Welcome message: Welcome to Spring Fair 2026.");
    await markDatesChecked(editor, copyId);
    expect((await botById(copyId))?.datesCheckedAt).toBeInstanceOf(Date);
  });
});
