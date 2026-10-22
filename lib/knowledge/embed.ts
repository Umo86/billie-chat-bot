import "server-only";
import { createHash } from "node:crypto";
import { embeddingsProvider } from "@/lib/config";
import { EMBEDDING_DIMENSIONS } from "@/lib/db/schema/bots";

/**
 * Embeddings for search by meaning. Voyage AI (voyage-4, 1024 dimensions)
 * when VOYAGE_API_KEY is set; nothing otherwise, and search falls back to
 * keywords alone. Batched, retried on rate limits and outages, and never
 * fatal: a failed embedding leaves the passage findable by keyword.
 */
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const BATCH = 96;

export function embeddingsEnabled(): boolean {
  return embeddingsProvider() !== "none";
}

function model(): string {
  return process.env.VOYAGE_MODEL?.trim() || "voyage-4";
}

async function voyageBatch(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  let lastError = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(VOYAGE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        },
        body: JSON.stringify({
          input: texts,
          model: model(),
          input_type: inputType,
          output_dimension: EMBEDDING_DIMENSIONS,
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
        const out: number[][] = new Array(texts.length);
        for (const d of body.data) out[d.index] = d.embedding;
        if (out.some((e) => !Array.isArray(e) || e.length !== EMBEDDING_DIMENSIONS)) {
          throw new Error("unexpected embedding size");
        }
        return out;
      }
      lastError = `Voyage ${res.status}`;
      // Bad request or key: retrying won't help.
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw new Error(`Embedding failed: ${lastError}`);
}

/** A deterministic bag-of-words vector (tests and demos): shared words → similar vectors. */
export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  for (const w of words) {
    const stem = w.replace(/(ies|es|s|ing|ed)$/, "");
    const h = createHash("sha256").update(stem).digest();
    v[h.readUInt16BE(0) % EMBEDDING_DIMENSIONS] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** Embeddings for `texts`, or null when meaning search isn't set up. */
export async function embed(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][] | null> {
  const provider = embeddingsProvider();
  if (provider === "none" || !texts.length) return null;
  if (provider === "fake") return texts.map(fakeEmbedding);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await voyageBatch(texts.slice(i, i + BATCH), inputType)));
  }
  return out;
}

/** One query embedding, or null on any failure (search carries on with keywords). */
export async function embedQuery(text: string): Promise<number[] | null> {
  try {
    const out = await embed([text.slice(0, 4000)], "query");
    return out?.[0] ?? null;
  } catch (err) {
    console.warn("query embedding failed", err instanceof Error ? err.message : err);
    return null;
  }
}
