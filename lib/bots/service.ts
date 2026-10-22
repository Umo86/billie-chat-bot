import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botKnowledgeBases, bots, knowledgeBases } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { answerQuestion } from "@/lib/ai/answer";
import { normaliseDomain } from "@/lib/chat/domains";
import type { Actor } from "@/lib/authz";
import type { BotRules, TestQuestion, TestResult, TestRun } from "@/lib/types";
import { UserError } from "@/lib/errors";
import { answerBotFor, botById } from "./load";
import { defaultQuality, defaultRules } from "./defaults";
import { uniqueSlug } from "./slug";

/**
 * Bots: create, edit, test, put live. A bot can only go live once its saved
 * test questions have been run (build plan), and taking it back to draft
 * stops it answering on websites and WhatsApp at once.
 */
export type BotLook = {
  name: string;
  audience: "visitors" | "exhibitors";
  showName: string;
  color: string;
  avatarUrl: string | null;
  welcome: string;
  starters: string[];
};

export type BotPatch = Partial<
  BotLook & {
    tone: "friendly" | "formal" | "brief";
    quality: "fast" | "thorough";
    rules: BotRules;
    domains: string[];
    tests: TestQuestion[];
  }
>;

export async function createBot(actor: Actor, look: BotLook): Promise<string> {
  const taken = (await db.select({ slug: bots.slug }).from(bots)).map((r) => r.slug);
  return db.transaction(async (tx) => {
    const [bot] = await tx
      .insert(bots)
      .values({
        ...look,
        slug: uniqueSlug(look.name, taken),
        rules: defaultRules(look.audience),
        quality: defaultQuality(look.audience),
        createdBy: actor.id,
      })
      .returning({ id: bots.id, name: bots.name });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: bot.id,
      action: "create",
      summary: `Created bot "${bot.name}"`,
    });
    return bot.id;
  });
}

export async function updateBot(actor: Actor, id: string, patch: BotPatch): Promise<void> {
  const values: BotPatch = { ...patch };
  if (patch.domains) {
    values.domains = [
      ...new Set(
        patch.domains.map((d) => normaliseDomain(d)).filter((d): d is string => Boolean(d)),
      ),
    ];
  }
  await db.transaction(async (tx) => {
    const [bot] = await tx
      .update(bots)
      .set(values)
      .where(and(eq(bots.id, id), isNull(bots.deletedAt)))
      .returning({ id: bots.id, name: bots.name });
    if (!bot) throw new UserError("That bot no longer exists.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: bot.id,
      action: "update",
      summary: `Changed ${Object.keys(patch).join(", ")} on "${bot.name}"`,
    });
  });
}

export async function setKnowledge(actor: Actor, botId: string, kbIds: string[]): Promise<void> {
  const valid = kbIds.length
    ? (
        await db
          .select({ id: knowledgeBases.id })
          .from(knowledgeBases)
          .where(and(inArray(knowledgeBases.id, kbIds), isNull(knowledgeBases.deletedAt)))
      ).map((r) => r.id)
    : [];
  await db.transaction(async (tx) => {
    const bot = await tx.query.bots.findFirst({
      where: and(eq(bots.id, botId), isNull(bots.deletedAt)),
    });
    if (!bot) throw new UserError("That bot no longer exists.");
    await tx.delete(botKnowledgeBases).where(eq(botKnowledgeBases.botId, botId));
    if (valid.length)
      await tx.insert(botKnowledgeBases).values(valid.map((k) => ({ botId, knowledgeBaseId: k })));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "update",
      summary: `Set "${bot.name}" to answer from ${valid.length} knowledge base${valid.length === 1 ? "" : "s"}`,
    });
  });
}

export async function setStatus(actor: Actor, id: string, status: "draft" | "live"): Promise<void> {
  const bot = await botById(id);
  if (!bot) throw new UserError("That bot no longer exists.");
  if (status === "live" && !bot.lastTestRun?.total) {
    throw new UserError(
      "Run the test questions first. You can put the bot live once it has been tested.",
    );
  }
  await db.transaction(async (tx) => {
    await tx.update(bots).set({ status }).where(eq(bots.id, id));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: id,
      action: "status_change",
      summary: status === "live" ? `Put "${bot.name}" live` : `Took "${bot.name}" back to draft`,
    });
  });
}

/** Soft delete: chats stay in the Inbox; the bot waits in the bin for 30 days. */
export async function deleteBot(actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [bot] = await tx
      .update(bots)
      .set({ deletedAt: new Date(), status: "draft" })
      .where(and(eq(bots.id, id), isNull(bots.deletedAt)))
      .returning({ id: bots.id, name: bots.name });
    if (!bot) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: id,
      action: "delete",
      summary: `Deleted bot "${bot.name}" (in the bin for 30 days)`,
    });
  });
}

export async function restoreBot(actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [bot] = await tx
      .update(bots)
      .set({ deletedAt: null })
      .where(eq(bots.id, id))
      .returning({ id: bots.id, name: bots.name });
    if (!bot) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: id,
      action: "restore",
      summary: `Restored bot "${bot.name}"`,
    });
  });
}

/** Scores one answer against a saved test question. */
export function scoreTest(
  t: TestQuestion,
  answer: { answer: string; handover: TestResult["handover"]; sources: unknown[] },
): TestResult {
  const text = answer.answer.toLowerCase();
  const words = t.mustMention
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  const missing = words.filter((w) => !text.includes(w));
  return {
    id: t.id,
    question: t.question,
    pass: answer.handover === "none" && answer.sources.length > 0 && missing.length === 0,
    answer: answer.answer,
    handover: answer.handover,
    missing,
  };
}

/** Replays every saved test question and records the result on the bot. */
export async function runTests(actor: Actor, id: string): Promise<TestRun> {
  const bot = await botById(id);
  if (!bot) throw new UserError("That bot no longer exists.");
  if (!bot.tests.length) throw new UserError("Add at least one test question first.");
  const answerBot = await answerBotFor(bot);
  const results: TestResult[] = [];
  for (const t of bot.tests) {
    try {
      const a = await answerQuestion({ bot: answerBot, history: [], question: t.question });
      results.push(scoreTest(t, a));
    } catch (err) {
      results.push({
        id: t.id,
        question: t.question,
        pass: false,
        answer: err instanceof Error ? err.message : "Failed",
        handover: "unknown",
        missing: [],
        error: true,
      });
    }
  }
  const run: TestRun = {
    at: new Date().toISOString(),
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    results,
  };
  await db.transaction(async (tx) => {
    await tx.update(bots).set({ lastTestRun: run }).where(eq(bots.id, id));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: id,
      action: "update",
      summary: `Ran test questions on "${bot.name}": ${run.passed} of ${run.total} passed`,
    });
  });
  return run;
}
