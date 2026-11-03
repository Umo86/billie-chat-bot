import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { knowledgeBases, knowledgeChecks, passages, sources } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { enqueue, PermanentJobError } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { AiError, structured } from "@/lib/ai/provider";
import { fallbackFor, modelFor } from "@/lib/ai/models";
import { knowledgeCheckSystem, knowledgeCheckUser, type CheckSource } from "@/lib/ai/prompts";
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

/** About 45,000 tokens: a long exhibitor manual. Larger bases are checked in part, and say so. */
export const MAX_CHECK_CHARS = 180_000;

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

export async function latestCheck(kbId: string): Promise<CheckView | null> {
  const [c] = await db
    .select()
    .from(knowledgeChecks)
    .where(eq(knowledgeChecks.knowledgeBaseId, kbId))
    .orderBy(desc(knowledgeChecks.createdAt))
    .limit(1);
  if (!c) return null;
  return {
    id: c.id,
    status: c.status,
    issues: c.issues,
    checkedSources: c.checkedSources,
    totalSources: c.totalSources,
    error: c.error,
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
          sql`${knowledgeChecks.createdAt} > now() - interval '15 minutes'`,
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
  await kickJobs();
  return id;
}

/** Each ready source's text, in the order it was added, until the size limit. */
async function sourcesToCheck(kbId: string) {
  const rows = await db
    .select({
      id: sources.id,
      title: sources.title,
      kind: sources.kind,
      text: passages.text,
    })
    .from(passages)
    .innerJoin(sources, eq(sources.id, passages.sourceId))
    .where(
      and(
        eq(sources.knowledgeBaseId, kbId),
        eq(sources.status, "ready"),
        isNull(sources.deletedAt),
      ),
    )
    .orderBy(asc(sources.createdAt), asc(sources.id), asc(passages.ordinal));
  const byId = new Map<string, CheckSource & { id: string }>();
  for (const r of rows) {
    const s = byId.get(r.id);
    if (s) s.text += `\n\n${r.text}`;
    else byId.set(r.id, { id: r.id, title: r.title, kind: r.kind, text: r.text });
  }
  const all = [...byId.values()];
  const picked: typeof all = [];
  let used = 0;
  for (const s of all) {
    if (used + s.text.length > MAX_CHECK_CHARS) {
      if (!picked.length) picked.push({ ...s, text: s.text.slice(0, MAX_CHECK_CHARS) });
      break;
    }
    picked.push(s);
    used += s.text.length;
  }
  return { all, picked };
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

  await db
    .update(knowledgeChecks)
    .set({ status: "running" })
    .where(eq(knowledgeChecks.id, checkId));
  const { all, picked } = await sourcesToCheck(kb.id);
  if (!picked.length) {
    await db
      .update(knowledgeChecks)
      .set({ status: "done", issues: [], finishedAt: new Date() })
      .where(eq(knowledgeChecks.id, checkId));
    return;
  }

  const now = opts.now ?? new Date();
  let issues: CheckIssue[];
  try {
    if (await capReached())
      throw new AiError("cap_reached", "Today's answer limit has been reached");
    const res = await structured({
      purpose: "knowledge_check",
      model: modelFor("thorough"),
      fallbackModel: fallbackFor("thorough"),
      system: knowledgeCheckSystem(),
      user: knowledgeCheckUser(kb.name, picked, now),
      schema: knowledgeCheckJsonSchema,
      maxTokens: 4000,
      timeoutMs: 120_000,
      fake: { purpose: "knowledge_check", sources: picked, now },
    });
    await recordUsage("check", res.usage);
    const parsed = knowledgeCheckSchema.parse(res.json);
    // Link each named source to its row, so the screen can offer Edit or View.
    const byTitle = new Map(picked.map((s) => [s.title.trim().toLowerCase(), s]));
    issues = parsed.issues
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
            const s = byTitle.get(t.toLowerCase());
            return s ? { title: s.title, id: s.id, kind: s.kind } : { title: t.slice(0, 200) };
          }),
      }))
      .filter((i) => i.title)
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  } catch (err) {
    if (err instanceof AiError && err.code === "not_configured")
      return void (await fail("Claude isn't connected yet (ANTHROPIC_API_KEY)."));
    if (err instanceof AiError && err.code === "cap_reached")
      return void (await fail("Today's answer limit has been reached. Try again tomorrow."));
    if (opts.lastTry) return void (await fail("Billie couldn't finish the check. Try again."));
    throw err; // tried again shortly
  }

  await db
    .update(knowledgeChecks)
    .set({
      status: "done",
      issues,
      checkedSources: picked.length,
      totalSources: all.length,
      error: null,
      finishedAt: new Date(),
    })
    .where(eq(knowledgeChecks.id, checkId));
}
