import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { knowledgeBases, knowledgeChecks, passages, sources } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { enqueue, PermanentJobError } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { AiError, structured } from "@/lib/ai/provider";
import { modelsFor } from "@/lib/ai/chosen";
import { knowledgeCheckSystem, knowledgeCheckUser } from "@/lib/ai/prompts";
import { knowledgeCheckJsonSchema, knowledgeCheckSchema } from "@/lib/ai/schemas";
import { capReached, recordUsage } from "@/lib/ai/usage";
import type { Actor } from "@/lib/authz";
import type { CheckIssue } from "@/lib/types";
import { KnowledgeError } from "./sources";

/**
 * The knowledge check (the "knowledge_check" job): Claude reads a whole
 * knowledge base and lists contradictions, dates that have passed and
 * contact details that don't match, so the team can fix them before a bot
 * gives two answers to one question. On demand only; one Claude call.
 */

/** About 40,000 tokens: a long exhibitor manual. Larger bases are checked in part, and say so. */
export const MAX_CHECK_CHARS = 160_000;

export type CheckView = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  issues: CheckIssue[];
  checkedSources: number;
  totalSources: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

/** A check still waiting or running after this long was cut off: show it as failed. */
export const STALE_CHECK_MS = 15 * 60_000;

export async function latestCheck(kbId: string, now = new Date()): Promise<CheckView | null> {
  const [c] = await db
    .select()
    .from(knowledgeChecks)
    .where(eq(knowledgeChecks.knowledgeBaseId, kbId))
    .orderBy(desc(knowledgeChecks.createdAt))
    .limit(1);
  if (!c) return null;
  const stale =
    (c.status === "queued" || c.status === "running") &&
    now.getTime() - c.createdAt.getTime() > STALE_CHECK_MS;
  return {
    id: c.id,
    status: stale ? "failed" : c.status,
    issues: c.issues,
    checkedSources: c.checkedSources,
    totalSources: c.totalSources,
    error: stale ? "It didn't finish. Try again." : c.error,
    createdAt: c.createdAt.toISOString(),
    finishedAt: c.finishedAt?.toISOString() ?? null,
  };
}

/** Queues a check, or returns the one already waiting or running for this knowledge base. */
export async function requestCheck(actor: Actor, kbId: string): Promise<string> {
  const id = await db.transaction(async (tx) => {
    const [kb] = await tx
      .select({ id: knowledgeBases.id, name: knowledgeBases.name })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, kbId), isNull(knowledgeBases.deletedAt)))
      .for("update");
    if (!kb) throw new KnowledgeError("That knowledge base no longer exists.");
    const [open] = await tx
      .select({ id: knowledgeChecks.id })
      .from(knowledgeChecks)
      .where(
        and(
          eq(knowledgeChecks.knowledgeBaseId, kb.id),
          inArray(knowledgeChecks.status, ["queued", "running"]),
          sql`${knowledgeChecks.createdAt} > ${new Date(Date.now() - STALE_CHECK_MS).toISOString()}::timestamptz`,
        ),
      )
      .limit(1);
    if (open) return open.id;
    const [row] = await tx
      .insert(knowledgeChecks)
      .values({ knowledgeBaseId: kb.id, requestedBy: actor.id })
      .returning({ id: knowledgeChecks.id });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "knowledge_base",
      entityId: kb.id,
      action: "update",
      summary: `Asked Billie to check "${kb.name}"`,
    });
    await enqueue(
      "knowledge_check",
      { checkId: row.id },
      { tx, dedupeKey: `check:${row.id}`, maxAttempts: 3 },
    );
    return row.id;
  });
  await kickJobs({ long: true });
  return id;
}

/** Sources bots answer from: read, or being read again (their old passages still count). */
const LIVE = ["ready", "queued", "reading"] as const;

/**
 * Each source's text, in the order it was added, until the size limit. Only
 * the sources that fit are loaded, so a very large knowledge base doesn't
 * fill the server's memory. Each gets a label (S1, S2…) that Claude names
 * it by, so two sources with the same title can't be mixed up.
 */
async function sourcesToCheck(kbId: string) {
  const sizes = await db
    .select({
      id: sources.id,
      title: sources.title,
      kind: sources.kind,
      chars: sql<number>`sum(length(${passages.text}))::int`,
    })
    .from(passages)
    .innerJoin(sources, eq(sources.id, passages.sourceId))
    .where(
      and(
        eq(sources.knowledgeBaseId, kbId),
        inArray(sources.status, [...LIVE]),
        isNull(sources.deletedAt),
      ),
    )
    .groupBy(sources.id, sources.title, sources.kind, sources.createdAt)
    .orderBy(asc(sources.createdAt), asc(sources.id));
  const chosen: typeof sizes = [];
  let used = 0;
  for (const s of sizes) {
    if (used + s.chars > MAX_CHECK_CHARS && chosen.length) break;
    chosen.push(s);
    used += s.chars;
  }
  const rows = chosen.length
    ? await db
        .select({ sourceId: passages.sourceId, text: passages.text })
        .from(passages)
        .where(
          inArray(
            passages.sourceId,
            chosen.map((s) => s.id),
          ),
        )
        .orderBy(asc(passages.sourceId), asc(passages.ordinal))
    : [];
  const text = new Map<string, string[]>();
  for (const r of rows) text.set(r.sourceId, [...(text.get(r.sourceId) ?? []), r.text]);
  const picked = chosen.map((s, i) => ({
    id: s.id,
    label: `S${i + 1}`,
    title: s.title,
    kind: s.kind,
    // A single source bigger than the limit is checked in part.
    text: (text.get(s.id) ?? []).join("\n\n").slice(0, MAX_CHECK_CHARS),
  }));
  return { total: sizes.length, picked };
}

const KIND_ORDER: Record<CheckIssue["kind"], number> = {
  contradiction: 0,
  date_passed: 1,
  contact: 2,
  unclear: 3,
};

export async function runKnowledgeCheck(
  checkId: string,
  opts: { lastTry?: boolean; now?: Date } = {},
): Promise<void> {
  const check = await db.query.knowledgeChecks.findFirst({
    where: eq(knowledgeChecks.id, checkId),
  });
  if (!check) throw new PermanentJobError("Check not found");
  if (check.status === "done" || check.status === "failed") return;
  const kb = await db.query.knowledgeBases.findFirst({
    where: and(eq(knowledgeBases.id, check.knowledgeBaseId), isNull(knowledgeBases.deletedAt)),
  });
  const fail = (error: string) =>
    db
      .update(knowledgeChecks)
      .set({ status: "failed", error, finishedAt: new Date() })
      .where(eq(knowledgeChecks.id, checkId));
  if (!kb) return void (await fail("The knowledge base was deleted."));

  try {
    await db
      .update(knowledgeChecks)
      .set({ status: "running" })
      .where(eq(knowledgeChecks.id, checkId));
    const { total, picked } = await sourcesToCheck(kb.id);
    if (!picked.length) {
      await db
        .update(knowledgeChecks)
        .set({ status: "done", issues: [], finishedAt: new Date() })
        .where(eq(knowledgeChecks.id, checkId));
      return;
    }
    const issues = await askForIssues(kb.name, picked, opts.now ?? new Date());
    await db
      .update(knowledgeChecks)
      .set({
        status: "done",
        issues,
        checkedSources: picked.length,
        totalSources: total,
        error: null,
        finishedAt: new Date(),
      })
      .where(eq(knowledgeChecks.id, checkId));
  } catch (err) {
    if (err instanceof AiError && err.code === "not_configured")
      return void (await fail("Claude isn't connected yet (ANTHROPIC_API_KEY)."));
    if (err instanceof AiError && err.code === "cap_reached")
      return void (await fail("Today's answer limit has been reached. Try again tomorrow."));
    if (opts.lastTry) return void (await fail("Billie couldn't finish the check. Try again."));
    throw err; // tried again shortly
  }
}

type Picked = Awaited<ReturnType<typeof sourcesToCheck>>["picked"];

/**
 * One Claude call. Bounded so it always finishes inside the job's lease and
 * a five-minute function: no SDK retries, 100 seconds a try, and at most one
 * try on the fallback model; the reply lists at most 20 problems.
 */
async function askForIssues(kbName: string, picked: Picked, now: Date): Promise<CheckIssue[]> {
  if (await capReached()) throw new AiError("cap_reached", "Today's answer limit has been reached");
  const res = await structured({
    purpose: "knowledge_check",
    ...(await modelsFor("thorough")),
    system: knowledgeCheckSystem(),
    user: knowledgeCheckUser(kbName, picked, now),
    schema: knowledgeCheckJsonSchema,
    maxTokens: 6000,
    timeoutMs: 100_000,
    fake: { purpose: "knowledge_check", sources: picked, now },
  });
  await recordUsage("check", res.usage, res.model);
  const parsed = knowledgeCheckSchema.parse(res.json);
  // Link each source Claude names (by label, or else by title) to its row, for Edit and View.
  const byLabel = new Map(picked.map((s) => [s.label.toLowerCase(), s]));
  const byTitle = new Map(picked.map((s) => [s.title.trim().toLowerCase(), s]));
  return parsed.issues
    .slice(0, 20)
    .map((i) => ({
      kind: i.kind,
      title: i.title.trim().slice(0, 160),
      detail: i.detail.trim().slice(0, 800),
      quotes: i.quotes
        .map((q) => q.trim().slice(0, 400))
        .filter(Boolean)
        .slice(0, 4),
      sources: [...new Set(i.sources.map((t) => t.trim()).filter(Boolean))]
        .slice(0, 6)
        .map((t) => {
          const s = byLabel.get(t.toLowerCase()) ?? byTitle.get(t.toLowerCase());
          return s ? { title: s.title, id: s.id, kind: s.kind } : { title: t.slice(0, 200) };
        })
        .filter((x, n, all) => all.findIndex((y) => y.title === x.title && y.id === x.id) === n),
    }))
    .filter((i) => i.title)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}
