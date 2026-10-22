import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { passages, sources } from "@/lib/db/schema";
import { readStoredFile } from "@/lib/storage";
import { PermanentJobError } from "@/lib/jobs/queue";
import { chunkSegments, type Chunk, type Segment } from "./chunk";
import { capSegments, extractFile, UnreadableFileError, webPageSegments } from "./extract";
import { embed } from "./embed";
import { fetchPage, UnsafeUrlError } from "./web";

/**
 * Reading one source into passages (the "ingest_source" job). The source
 * shows Reading… while this runs and Ready or a plain-words error after.
 * Passages are replaced in one transaction, so a bot never sees half a
 * document. Embeddings are best-effort: without them, keyword search still
 * finds every passage.
 */
async function markFailed(id: string, error: string) {
  await db.update(sources).set({ status: "failed", error }).where(eq(sources.id, id));
}

function hashChunks(chunks: Chunk[]): string {
  const h = createHash("sha256");
  for (const c of chunks) h.update(c.label).update("\u0000").update(c.text).update("\u0001");
  return h.digest("hex");
}

export async function ingestSource(sourceId: string): Promise<void> {
  const src = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
  if (!src) throw new PermanentJobError("Source not found");
  if (src.deletedAt) return;

  await db.update(sources).set({ status: "reading", error: null }).where(eq(sources.id, sourceId));

  let segments: Segment[];
  let title = src.title;
  try {
    switch (src.kind) {
      case "file": {
        if (!src.fileKey) throw new UnreadableFileError("The file is missing. Upload it again.");
        const bytes = await readStoredFile(src.fileKey);
        segments = await extractFile(bytes, src.fileName ?? src.title, src.mimeType);
        break;
      }
      case "web": {
        if (!src.url) throw new UnsafeUrlError("The address is missing.");
        const page = await fetchPage(src.url);
        const read = webPageSegments(page.body, page.url);
        segments = read.segments;
        if (src.title === src.url && read.title) title = read.title;
        break;
      }
      case "text":
      case "qa":
        segments = [{ text: src.body ?? "", label: src.kind === "qa" ? "Typed answer" : "" }];
        break;
    }
  } catch (err) {
    if (err instanceof UnreadableFileError || err instanceof UnsafeUrlError) {
      await markFailed(sourceId, err.message);
      return; // Retrying won't change the file or the address.
    }
    await markFailed(sourceId, "Couldn't read it this time. Billie will try again shortly.");
    throw err;
  }

  const { segments: capped, truncated } = capSegments(segments);
  // A typed answer stays one passage: the question and its answer belong together.
  const chunks =
    src.kind === "qa"
      ? capped.map((s) => ({ text: s.text.trim(), label: s.label })).filter((c) => c.text)
      : chunkSegments(capped);
  if (!chunks.length) {
    await markFailed(sourceId, "No text found to learn from.");
    return;
  }

  const contentHash = hashChunks(chunks);
  if (src.kind === "web" && src.status === "ready" && src.contentHash === contentHash) {
    await db.update(sources).set({ status: "ready", lastReadAt: new Date(), title }).where(eq(sources.id, sourceId));
    return; // The page hasn't changed since the last read.
  }

  let vectors: number[][] | null = null;
  try {
    vectors = await embed(
      chunks.map((c) => `${title}${c.label ? ` (${c.label})` : ""}\n${c.text}`),
      "document",
    );
  } catch (err) {
    console.warn("embeddings skipped", err instanceof Error ? err.message : err);
  }

  const chars = chunks.reduce((n, c) => n + c.text.length, 0);
  await db.transaction(async (tx) => {
    await tx.delete(passages).where(eq(passages.sourceId, sourceId));
    for (let i = 0; i < chunks.length; i += 200) {
      await tx.insert(passages).values(
        chunks.slice(i, i + 200).map((c, j) => ({
          sourceId,
          knowledgeBaseId: src.knowledgeBaseId,
          ordinal: i + j,
          text: c.text,
          label: c.label,
          embedding: vectors?.[i + j] ?? null,
        })),
      );
    }
    await tx
      .update(sources)
      .set({
        status: "ready",
        error: truncated ? "Only the first 2 million characters were read." : null,
        title,
        chars,
        passageCount: chunks.length,
        contentHash,
        lastReadAt: new Date(),
      })
      .where(eq(sources.id, sourceId));
  });
}
