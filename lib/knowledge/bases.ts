import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { gaps, knowledgeBases } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";
import { addSource } from "./sources";

export async function createKnowledgeBase(
  actor: Actor,
  name: string,
  description = "",
): Promise<string> {
  return db.transaction(async (tx) => {
    const [kb] = await tx
      .insert(knowledgeBases)
      .values({
        name: name.trim().slice(0, 80),
        description: description.trim().slice(0, 200),
        createdBy: actor.id,
      })
      .returning({ id: knowledgeBases.id, name: knowledgeBases.name });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "knowledge_base",
      entityId: kb.id,
      action: "create",
      summary: `Created knowledge base "${kb.name}"`,
    });
    return kb.id;
  });
}

export async function renameKnowledgeBase(
  actor: Actor,
  id: string,
  name: string,
  description: string,
) {
  await db.transaction(async (tx) => {
    const [kb] = await tx
      .update(knowledgeBases)
      .set({ name: name.trim().slice(0, 80), description: description.trim().slice(0, 200) })
      .where(and(eq(knowledgeBases.id, id), isNull(knowledgeBases.deletedAt)))
      .returning({ id: knowledgeBases.id, name: knowledgeBases.name });
    if (!kb) throw new UserError("That knowledge base no longer exists.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "knowledge_base",
      entityId: id,
      action: "update",
      summary: `Renamed a knowledge base to "${kb.name}"`,
    });
  });
}

export async function setKnowledgeBaseDeleted(actor: Actor, id: string, deleted: boolean) {
  await db.transaction(async (tx) => {
    const [kb] = await tx
      .update(knowledgeBases)
      .set({ deletedAt: deleted ? new Date() : null })
      .where(eq(knowledgeBases.id, id))
      .returning({ id: knowledgeBases.id, name: knowledgeBases.name });
    if (!kb) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "knowledge_base",
      entityId: id,
      action: deleted ? "delete" : "restore",
      summary: deleted
        ? `Deleted knowledge base "${kb.name}" (in the bin for 30 days)`
        : `Restored knowledge base "${kb.name}"`,
    });
  });
}

/** One click from the gaps list: the answer becomes a typed answer the bot uses from now on. */
export async function answerGap(
  actor: Actor,
  gapId: string,
  kbId: string,
  answer: string,
): Promise<void> {
  const gap = await db.query.gaps.findFirst({ where: eq(gaps.id, gapId) });
  if (!gap) throw new UserError("That question is no longer on the list.");
  const sourceId = await addSource(actor, kbId, { kind: "qa", question: gap.question, answer });
  await db
    .update(gaps)
    .set({ status: "answered", answeredSourceId: sourceId })
    .where(eq(gaps.id, gapId));
}

export async function dismissGap(actor: Actor, gapId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [g] = await tx
      .update(gaps)
      .set({ status: "dismissed" })
      .where(eq(gaps.id, gapId))
      .returning({ id: gaps.id });
    if (!g) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "gap",
      entityId: gapId,
      action: "status_change",
      summary: "Dismissed an unanswered question",
    });
  });
}
