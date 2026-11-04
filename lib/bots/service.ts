import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { blueprintLinks, bots, deadlines, exhibitorLists, exhibitors } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { answerQuestion } from "@/lib/ai/answer";
import { normaliseDomain } from "@/lib/chat/domains";
import type { Actor } from "@/lib/authz";
import type { BotRules, RequestType, TestQuestion, TestResult, TestRun } from "@/lib/types";
import { UserError } from "@/lib/errors";
import { createBotKnowledgeBase, renameBotKnowledgeBase } from "@/lib/knowledge/bases";
import { answerBotFor, botById } from "./load";
import { addToBot } from "./people";
import { defaultQuality, defaultRules, forNewType } from "./defaults";
import { uniqueSlug } from "./slug";
import type { ShowDays } from "./show-days";
import type { PageStarters } from "./page-starters";

/**
 * Bots: create, edit, test, put live. A bot can only go live once its saved
 * test questions have been run (build plan), and taking it back to draft
 * stops it answering on websites and WhatsApp at once. Each bot is made with
 * its own knowledge base, named after it.
 */
export type BotLook = {
  name: string;
  audience: "visitors" | "exhibitors";
  showName: string;
  color: string;
  avatarUrl: string | null;
  welcome: string;
  starters: string[];
  /** Different starters on some pages (lib/bots/page-starters.ts). */
  pageStarters?: PageStarters[];
  /** Build-up to breakdown; null clears them (lib/bots/show-days.ts). */
  showDays?: ShowDays | null;
};

/** The show days as the bot's two columns. */
function dayColumns(d: ShowDays | null | undefined) {
  if (d === undefined) return {};
  return { showStartsOn: d?.from ?? null, showEndsOn: d?.to ?? null };
}

export type BotPatch = Partial<
  BotLook & {
    tone: "friendly" | "formal" | "brief";
    personality: string;
    emoji: boolean;
    emailSignOff: string;
    quality: "fast" | "thorough";
    rules: BotRules;
    domains: string[];
    tests: TestQuestion[];
    requestTypes: RequestType[];
    personalAnswers: boolean;
  }
>;

export async function createBot(actor: Actor, look: BotLook): Promise<string> {
  const taken = (await db.select({ slug: bots.slug }).from(bots)).map((r) => r.slug);
  const { showDays, ...rest } = look;
  return db.transaction(async (tx) => {
    const [bot] = await tx
      .insert(bots)
      .values({
        ...rest,
        ...dayColumns(showDays),
        slug: uniqueSlug(look.name, taken),
        rules: defaultRules(look.audience),
        quality: defaultQuality(look.audience),
        createdBy: actor.id,
      })
      .returning({ id: bots.id, name: bots.name });
    await createBotKnowledgeBase(tx, bot, actor.id);
    // Whoever makes a bot works on it.
    await addToBot(tx, bot.id, actor.id, actor.id);
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
  const { showDays, ...rest } = patch;
  const values: Omit<BotPatch, "showDays"> & ReturnType<typeof dayColumns> = {
    ...rest,
    ...dayColumns(showDays),
  };
  if (patch.domains) {
    values.domains = [
      ...new Set(
        patch.domains.map((d) => normaliseDomain(d)).filter((d): d is string => Boolean(d)),
      ),
    ];
  }
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        name: bots.name,
        audience: bots.audience,
        rules: bots.rules,
        quality: bots.quality,
      })
      .from(bots)
      .where(and(eq(bots.id, id), isNull(bots.deletedAt)))
      .for("update");
    if (!before) throw new UserError("That bot no longer exists.");
    const switched = patch.audience !== undefined && patch.audience !== before.audience;
    if (switched) {
      // A visitor chatbot has no exhibitor list: one left on it would be out of sight.
      if (patch.audience === "visitors") await refuseIfExhibitorData(tx, id);
      const next = forNewType(before.audience, patch.audience!, {
        rules: patch.rules ?? before.rules,
        quality: patch.quality ?? before.quality,
      });
      values.rules = next.rules;
      values.quality = next.quality;
      if (patch.audience === "visitors") values.personalAnswers = false;
    }
    const [bot] = await tx
      .update(bots)
      .set(values)
      .where(eq(bots.id, id))
      .returning({ id: bots.id, name: bots.name });
    if (patch.name !== undefined) await renameBotKnowledgeBase(tx, bot.id, bot.name);
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: bot.id,
      action: "update",
      summary: switched
        ? `Made "${bot.name}" ${patch.audience === "visitors" ? "a visitor" : "an exhibitor"} chatbot (it was ${before.audience === "visitors" ? "a visitor" : "an exhibitor"} chatbot)`
        : `Changed ${Object.keys(patch).join(", ")} on "${bot.name}"`,
    });
  });
}

/**
 * Before an exhibitor chatbot becomes a visitor one: its exhibitor list,
 * BluePrint connection and deadlines have to go first (Exhibitors step), as
 * a visitor chatbot has no Exhibitors step to see or remove them on.
 */
async function refuseIfExhibitorData(tx: Tx, botId: string): Promise<void> {
  const [list] = await tx
    .select({ id: exhibitorLists.botId })
    .from(exhibitorLists)
    .where(eq(exhibitorLists.botId, botId))
    .limit(1);
  const [row] = list
    ? [list]
    : await tx
        .select({ id: exhibitors.id })
        .from(exhibitors)
        .where(eq(exhibitors.botId, botId))
        .limit(1);
  const [link] = await tx
    .select({ id: blueprintLinks.botId })
    .from(blueprintLinks)
    .where(eq(blueprintLinks.botId, botId))
    .limit(1);
  const [deadline] = await tx
    .select({ id: deadlines.id })
    .from(deadlines)
    .where(eq(deadlines.botId, botId))
    .limit(1);
  const has = [
    row && "an exhibitor list",
    link && "BluePrint connected",
    deadline && "deadlines",
  ].filter(Boolean) as string[];
  if (!has.length) return;
  const what =
    has.length === 1 ? has[0] : `${has.slice(0, -1).join(", ")} and ${has[has.length - 1]}`;
  throw new UserError(
    `This bot has ${what}. A visitor chatbot doesn't use them, so remove them on the Exhibitors step first, then switch it.`,
  );
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
  // Three at a time: quick enough for 50 questions, gentle on rate limits.
  const results: TestResult[] = new Array(bot.tests.length);
  let next = 0;
  async function worker() {
    while (next < bot!.tests.length) {
      const i = next++;
      const t = bot!.tests[i];
      try {
        const a = await answerQuestion({ bot: answerBot, history: [], question: t.question });
        results[i] = scoreTest(t, a);
      } catch (err) {
        results[i] = {
          id: t.id,
          question: t.question,
          pass: false,
          answer: err instanceof Error ? err.message : "Failed",
          handover: "unknown",
          missing: [],
          error: true,
        };
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
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
