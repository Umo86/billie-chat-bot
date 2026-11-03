import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { knowledgeBases, sources } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import type { Actor } from "@/lib/authz";
import { KnowledgeError, qaBody } from "./sources";
import { countMatches, matchSnippets, replaceAllText, splitQa, type Snippet } from "./replace";

/**
 * Changing knowledge in place: editing pasted text and typed answers, and
 * replacing a piece of text (an email address, a phone number, a name)
 * across a whole knowledge base. Files and web pages can't be changed here:
 * the preview lists them, to be changed at the source and read again.
 *
 * Each change saves the new text, writes its audit row and queues a fresh
 * read in one transaction. The queued read has a key of its own per version
 * of the text, so it isn't lost behind a read of the old text that is still
 * running (ingest.ts throws that older read's result away).
 */

export type EditableSource =
  { kind: "text"; title: string; body: string } | { kind: "qa"; question: string; answer: string };

function readKey(id: string, title: string, body: string): string {
  const v = createHash("sha256").update(title).update("\u0000").update(body).digest("hex");
  return `ingest:${id}:${v.slice(0, 16)}`;
}

function textTitle(title: string, body: string): string {
  return title.trim().slice(0, 200) || body.trim().split("\n")[0].slice(0, 60) || "Pasted text";
}

const quoted = (s: string) => `"${s.length > 60 ? `${s.slice(0, 57)}…` : s}"`;

export async function sourceForEdit(sourceId: string): Promise<EditableSource> {
  const s = await db.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), isNull(sources.deletedAt)),
    columns: { kind: true, title: true, body: true },
  });
  if (!s) throw new KnowledgeError("That source no longer exists.");
  if (s.kind === "text") return { kind: "text", title: s.title, body: s.body ?? "" };
  if (s.kind === "qa") {
    const { question, answer } = splitQa(s.body ?? "");
    return { kind: "qa", question: question || s.title, answer };
  }
  throw new KnowledgeError(
    "Files and web pages can't be edited here. Change the original, then read it again.",
  );
}

/** Saves the new text and has Billie read it again. False when nothing changed. */
export async function editSource(
  actor: Actor,
  sourceId: string,
  edit: EditableSource,
): Promise<boolean> {
  const changed = await db.transaction(async (tx) => {
    const [s] = await tx
      .select({ id: sources.id, kind: sources.kind, title: sources.title, body: sources.body })
      .from(sources)
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
      .for("update");
    if (!s) throw new KnowledgeError("That source no longer exists.");
    if (s.kind !== edit.kind) throw new KnowledgeError("This source can't be edited here.");
    const next =
      edit.kind === "text"
        ? { title: textTitle(edit.title, edit.body), body: edit.body.slice(0, 2_000_000) }
        : { title: edit.question.trim().slice(0, 200), body: qaBody(edit.question, edit.answer) };
    if (next.title === s.title && next.body === s.body) return false;
    await tx
      .update(sources)
      .set({ ...next, status: "queued", error: null })
      .where(eq(sources.id, s.id));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "source",
      entityId: s.id,
      action: "update",
      summary:
        next.title === s.title
          ? `Edited ${quoted(s.title)}`
          : `Edited ${quoted(s.title)} (now ${quoted(next.title)})`,
    });
    await enqueue(
      "ingest_source",
      { sourceId: s.id },
      { tx, dedupeKey: readKey(s.id, next.title, next.body) },
    );
    return true;
  });
  if (changed) await kickJobs();
  return changed;
}

export type ReplacePreview = {
  /** Pasted text and typed answers: changed when you confirm. */
  editable: { id: string; title: string; kind: "text" | "qa"; count: number; samples: Snippet[] }[];
  /** Files and web pages: change them at the source, then read them again. */
  elsewhere: { id: string; title: string; kind: "file" | "web"; count: number }[];
};

async function assertKb(kbId: string) {
  const kb = await db.query.knowledgeBases.findFirst({
    where: and(eq(knowledgeBases.id, kbId), isNull(knowledgeBases.deletedAt)),
    columns: { id: true, name: true },
  });
  if (!kb) throw new KnowledgeError("That knowledge base no longer exists.");
  return kb;
}

/** Pasted text and typed answers in the knowledge base that contain the text. */
function editableWhere(kbId: string, find: string) {
  return and(
    eq(sources.knowledgeBaseId, kbId),
    isNull(sources.deletedAt),
    inArray(sources.kind, ["text", "qa"]),
    or(
      sql`strpos(lower(coalesce(${sources.body}, '')), lower(${find})) > 0`,
      sql`strpos(lower(${sources.title}), lower(${find})) > 0`,
    ),
  );
}

/** The new title and text of a source after the replacement. */
function replaced(
  s: { kind: string; title: string; body: string | null },
  find: string,
  replace: string,
) {
  const body = s.body ?? "";
  if (s.kind === "qa") {
    const { question, answer } = splitQa(body);
    if (question) {
      const q = replaceAllText(question, find, replace).trim();
      const a = replaceAllText(answer, find, replace);
      return {
        title: q.slice(0, 200) || s.title,
        body: qaBody(q || question, a),
        count: countMatches(body, find),
      };
    }
  }
  return {
    title: replaceAllText(s.title, find, replace).trim().slice(0, 200) || s.title,
    body: replaceAllText(body, find, replace),
    count: countMatches(s.title, find) + countMatches(body, find),
  };
}

export async function previewReplace(
  kbId: string,
  find: string,
  replace: string,
): Promise<ReplacePreview> {
  await assertKb(kbId);
  const rows = await db
    .select({ id: sources.id, kind: sources.kind, title: sources.title, body: sources.body })
    .from(sources)
    .where(editableWhere(kbId, find))
    .orderBy(sources.title)
    .limit(500);
  const editable = rows.map((s) => {
    const r = replaced(s, find, replace);
    const inBody = matchSnippets(s.body ?? "", find, replace);
    return {
      id: s.id,
      title: s.title,
      kind: s.kind as "text" | "qa",
      count: r.count,
      // From the text; from the title when only the title has it.
      samples: inBody.length ? inBody : matchSnippets(s.title, find, replace),
    };
  });

  const elsewhere = await query<{ id: string; title: string; kind: "file" | "web"; n: string }>(
    db,
    sql`
    SELECT s.id, s.title, s.kind,
           sum((length(lower(p.text)) - length(replace(lower(p.text), lower(${find}), '')))
               / greatest(length(${find}), 1))::bigint AS n
    FROM passages p
    JOIN sources s ON s.id = p.source_id
    WHERE s.knowledge_base_id = ${kbId} AND s.deleted_at IS NULL
      AND s.kind IN ('file', 'web')
      AND strpos(lower(p.text), lower(${find})) > 0
    GROUP BY s.id, s.title, s.kind
    ORDER BY s.title
    LIMIT 200`,
  );
  return {
    editable,
    elsewhere: elsewhere.map((e) => ({
      id: e.id,
      title: e.title,
      kind: e.kind,
      count: Number(e.n),
    })),
  };
}

/** Replaces the text in every pasted text and typed answer of the knowledge base. */
export async function replaceInKnowledge(
  actor: Actor,
  kbId: string,
  find: string,
  replace: string,
): Promise<{ sources: number; matches: number }> {
  const done = await db.transaction(async (tx) => {
    const kb = await assertKb(kbId);
    const rows = await tx
      .select({ id: sources.id, kind: sources.kind, title: sources.title, body: sources.body })
      .from(sources)
      .where(editableWhere(kb.id, find))
      .for("update");
    let changedSources = 0;
    let matches = 0;
    for (const s of rows) {
      const next = replaced(s, find, replace);
      if (next.title === s.title && next.body === s.body) continue;
      await tx
        .update(sources)
        .set({ title: next.title, body: next.body, status: "queued", error: null })
        .where(eq(sources.id, s.id));
      await writeAudit(tx, {
        actorUserId: actor.id,
        entityType: "source",
        entityId: s.id,
        action: "update",
        summary: `Replaced ${quoted(find)} with ${quoted(replace)} in ${quoted(s.title)} (${kb.name})`,
      });
      await enqueue(
        "ingest_source",
        { sourceId: s.id },
        { tx, dedupeKey: readKey(s.id, next.title, next.body) },
      );
      changedSources++;
      matches += next.count;
    }
    return { sources: changedSources, matches };
  });
  if (done.sources) await kickJobs();
  return done;
}
