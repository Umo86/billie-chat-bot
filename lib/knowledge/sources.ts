import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { knowledgeBases, sources } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import type { Actor } from "@/lib/authz";
import { checkUrl } from "./web";

/**
 * Adding knowledge. Each add records the source (Reading… on screen),
 * writes its audit row and queues the read in one transaction, then starts
 * the queue. The read itself is lib/knowledge/ingest.ts.
 */
export type NewSource =
  | { kind: "text"; title: string; body: string }
  | { kind: "qa"; question: string; answer: string }
  | { kind: "web"; url: string; refreshWeekly: boolean }
  | { kind: "file"; name: string; fileKey: string; size: number; mimeType: string };

export class KnowledgeError extends Error {}

async function assertKb(kbId: string) {
  const kb = await db.query.knowledgeBases.findFirst({
    where: and(eq(knowledgeBases.id, kbId), isNull(knowledgeBases.deletedAt)),
  });
  if (!kb) throw new KnowledgeError("That knowledge base no longer exists.");
  return kb;
}

export function qaBody(question: string, answer: string): string {
  return `Q: ${question.trim()}\nA: ${answer.trim()}`;
}

export async function addSource(actor: Actor, kbId: string, input: NewSource): Promise<string> {
  const kb = await assertKb(kbId);
  const values = (() => {
    switch (input.kind) {
      case "text":
        return {
          title: input.title.trim().slice(0, 200) || input.body.trim().split("\n")[0].slice(0, 60) || "Pasted text",
          body: input.body.slice(0, 2_000_000),
        };
      case "qa":
        return { title: input.question.trim().slice(0, 200), body: qaBody(input.question, input.answer) };
      case "web": {
        const url = checkUrl(input.url).toString();
        return { title: url, url, refreshWeekly: input.refreshWeekly };
      }
      case "file":
        return {
          title: input.name.replace(/\.[^.]+$/, "").slice(0, 200) || "File",
          fileName: input.name.slice(0, 255),
          fileKey: input.fileKey,
          fileSize: input.size,
          mimeType: input.mimeType.slice(0, 120),
        };
    }
  })();

  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sources)
      .values({ knowledgeBaseId: kb.id, kind: input.kind, status: "queued", addedBy: actor.id, ...values })
      .returning({ id: sources.id, title: sources.title });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "source",
      entityId: row.id,
      action: "create",
      summary: `Added ${input.kind === "qa" ? "a typed answer" : input.kind} "${row.title}" to ${kb.name}`,
    });
    await enqueue("ingest_source", { sourceId: row.id }, { tx, dedupeKey: `ingest:${row.id}` });
    return row.id;
  });
  await kickJobs();
  return id;
}

/** Read a source again (after a failure, or to pick up a changed web page now). */
export async function rereadSource(actor: Actor, sourceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(sources)
      .set({ status: "queued", error: null })
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
      .returning({ id: sources.id, title: sources.title });
    if (!row) throw new KnowledgeError("That source no longer exists.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "source",
      entityId: row.id,
      action: "update",
      summary: `Asked Billie to read "${row.title}" again`,
    });
    await enqueue("ingest_source", { sourceId: row.id }, { tx, dedupeKey: `ingest:${row.id}` });
  });
  await kickJobs();
}

/** Soft delete: bots stop using it at once; it waits in the bin for 30 days (undo restores it). */
export async function deleteSource(actor: Actor, sourceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(sources)
      .set({ deletedAt: new Date() })
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
      .returning({ id: sources.id, title: sources.title });
    if (!row) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "source",
      entityId: row.id,
      action: "delete",
      summary: `Deleted "${row.title}" (in the bin for 30 days)`,
    });
  });
}

export async function restoreSource(actor: Actor, sourceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(sources)
      .set({ deletedAt: null })
      .where(eq(sources.id, sourceId))
      .returning({ id: sources.id, title: sources.title });
    if (!row) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "source",
      entityId: row.id,
      action: "restore",
      summary: `Restored "${row.title}"`,
    });
  });
}
