import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botKnowledgeBases, bots, gaps, knowledgeBases, sources } from "@/lib/db/schema";
import { createBot, updateBot } from "@/lib/bots/service";
import { answerBotFor, botById } from "@/lib/bots/load";
import { defaultRules } from "@/lib/bots/defaults";
import {
  answerGap,
  ensureBotKnowledgeBases,
  knowledgeBaseOf,
  setKnowledgeBaseDeleted,
} from "@/lib/knowledge/bases";
import { knowledgeBaseList } from "@/lib/knowledge/queries";
import { retrieve } from "@/lib/knowledge/search";
import { runRetention } from "@/lib/privacy/retention";
import { putFile, readStoredFile } from "@/lib/storage";
import { addAndRead, hasDb, makeBot, makeUser } from "../helpers/db";

const look = (name: string) => ({
  name,
  audience: "exhibitors" as const,
  showName: "Ideal Home Show Christmas 2026",
  color: "#0d6a5b",
  avatarUrl: null,
  welcome: "",
  starters: [],
});

describe.skipIf(!hasDb)("each bot has its own knowledge (Postgres)", () => {
  it("makes a knowledge base with every new bot, named after it and kept in step", async () => {
    const editor = await makeUser("editor");
    const id = await createBot(editor, look("IHS Exhibitor Help"));
    const kb = await db.query.knowledgeBases.findFirst({ where: eq(knowledgeBases.botId, id) });
    expect(kb).toMatchObject({ name: "IHS Exhibitor Help", deletedAt: null });
    // The old link table says the same, so a rollback still answers.
    const links = await db.select().from(botKnowledgeBases).where(eq(botKnowledgeBases.botId, id));
    expect(links.map((l) => l.knowledgeBaseId)).toEqual([kb!.id]);

    await updateBot(editor, id, { name: "IHS Christmas Help" });
    expect(
      (await db.query.knowledgeBases.findFirst({ where: eq(knowledgeBases.id, kb!.id) }))?.name,
    ).toBe("IHS Christmas Help");
    expect((await answerBotFor((await botById(id))!)).knowledgeBaseIds).toEqual([kb!.id]);
  });

  it("never answers from another bot's knowledge", async () => {
    const editor = await makeUser("editor");
    const a = await makeBot({ name: "Christmas Help" });
    const b = await makeBot({ name: "Spring Help" });
    await addAndRead(editor, a.kb.id, {
      kind: "text",
      title: "Build-up",
      body: "Christmas build-up starts on Tuesday 24 November at 10:30.",
    });
    await addAndRead(editor, b.kb.id, {
      kind: "text",
      title: "Build-up",
      body: "Spring build-up starts on Monday 16 March at 8am.",
    });
    const ids = (await answerBotFor(a.bot)).knowledgeBaseIds;
    expect(ids).toEqual([a.kb.id]);
    const found = await retrieve(ids, "When does build-up start?");
    expect(found.map((p) => p.text)).toEqual([
      "Christmas build-up starts on Tuesday 24 November at 10:30.",
    ]);
  });

  it("gives a bot made by the release before this one its knowledge when it's opened", async () => {
    const [bot] = await db
      .insert(bots)
      .values({
        name: "Made mid-release",
        slug: `mid-${randomUUID().slice(0, 8)}`,
        rules: defaultRules("exhibitors"),
      })
      .returning();
    expect(await answerBotFor(bot).then((x) => x.knowledgeBaseIds)).toEqual([]);
    const kb = await knowledgeBaseOf(bot.id);
    expect(kb.name).toBe("Made mid-release");
    expect((await knowledgeBaseOf(bot.id)).id).toBe(kb.id);
    await ensureBotKnowledgeBases(); // nothing more to make
    const all = await db.select().from(knowledgeBases).where(eq(knowledgeBases.botId, bot.id));
    expect(all).toHaveLength(1);
    expect(await answerBotFor(bot).then((x) => x.knowledgeBaseIds)).toEqual([kb.id]);
  });

  it("puts an unanswered question's answer into the asking bot's own knowledge", async () => {
    const editor = await makeUser("editor");
    const { bot, kb } = await makeBot();
    const other = await makeBot();
    const [gap] = await db
      .insert(gaps)
      .values({
        botId: bot.id,
        questionKey: `stand-${randomUUID().slice(0, 6)}`,
        question: "Can we bring a forklift?",
      })
      .returning();
    await answerGap(editor, gap.id, "No. The official contractor does all lifting.");
    const added = await db
      .select()
      .from(sources)
      .where(and(eq(sources.knowledgeBaseId, kb.id), eq(sources.kind, "qa")));
    expect(added.map((s) => s.title)).toEqual(["Can we bring a forklift?"]);
    expect(
      await db.select().from(sources).where(eq(sources.knowledgeBaseId, other.kb.id)),
    ).toHaveLength(0);
    expect((await db.query.gaps.findFirst({ where: eq(gaps.id, gap.id) }))?.status).toBe(
      "answered",
    );
  });

  it("deletes only an old shared knowledge base, never a bot's own", async () => {
    const admin = await makeUser("admin");
    const { kb } = await makeBot();
    await expect(setKnowledgeBaseDeleted(admin, kb.id, true)).rejects.toThrow(
      /deleted with the bot/,
    );
    const [old] = await db.insert(knowledgeBases).values({ name: "Old shared FAQ" }).returning();
    await setKnowledgeBaseDeleted(admin, old.id, true);
    expect(
      (await db.query.knowledgeBases.findFirst({ where: eq(knowledgeBases.id, old.id) }))
        ?.deletedAt,
    ).toBeTruthy();
    await setKnowledgeBaseDeleted(admin, old.id, false);
  });

  it("lists each bot's knowledge by bot name, then old shared bases, leaving deleted bots out", async () => {
    const zulu = await makeBot({ name: "Zulu show help" });
    const alpha = await makeBot({ name: "alpha show help" });
    const binned = await makeBot({ name: "Binned bot" });
    await db.update(bots).set({ deletedAt: new Date() }).where(eq(bots.id, binned.bot.id));
    const [old] = await db.insert(knowledgeBases).values({ name: "Aardvark FAQ" }).returning();

    const list = await knowledgeBaseList();
    const at = (id: string) => list.findIndex((k) => k.id === id);
    expect(at(alpha.kb.id)).toBeLessThan(at(zulu.kb.id));
    expect(at(binned.kb.id)).toBe(-1);
    expect(list.find((k) => k.id === zulu.kb.id)).toMatchObject({
      name: "Zulu show help",
      bot: { id: zulu.bot.id, name: "Zulu show help", status: "live" },
    });
    // Old shared bases come after every bot's own, whatever their name.
    const lastOwned = Math.max(...list.filter((k) => k.bot).map((k) => at(k.id)));
    expect(at(old.id)).toBeGreaterThan(lastOwned);
    expect(list[at(old.id)].bot).toBeNull();
  });

  it("empties a bot from the bin with its knowledge and files, keeping a file still in use", async () => {
    const editor = await makeUser("editor");
    const gone = await makeBot({ name: "Old show help" });
    const kept = await makeBot({ name: "New show help" });
    const own = await putFile("old-manual.txt", Buffer.from("Old manual."), "text/plain");
    const shared = await putFile("shared-plan.txt", Buffer.from("Floor plan."), "text/plain");
    await db.insert(sources).values([
      {
        knowledgeBaseId: gone.kb.id,
        kind: "file",
        title: "Old manual",
        fileKey: own,
        status: "ready",
      },
      {
        knowledgeBaseId: gone.kb.id,
        kind: "file",
        title: "Plan",
        fileKey: shared,
        status: "ready",
      },
      // A copy of the same file in another bot's knowledge.
      {
        knowledgeBaseId: kept.kb.id,
        kind: "file",
        title: "Plan",
        fileKey: shared,
        status: "ready",
        addedBy: editor.id,
      },
    ]);
    await db
      .update(bots)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(bots.id, gone.bot.id));

    const counts = await runRetention();
    expect(counts.bots).toBeGreaterThanOrEqual(1);
    expect(
      await db.query.knowledgeBases.findFirst({ where: eq(knowledgeBases.id, gone.kb.id) }),
    ).toBeUndefined();
    expect(
      await db.select().from(sources).where(eq(sources.knowledgeBaseId, gone.kb.id)),
    ).toHaveLength(0);
    await expect(readStoredFile(own)).rejects.toThrow();
    expect((await readStoredFile(shared)).toString()).toBe("Floor plan.");
  });
});
