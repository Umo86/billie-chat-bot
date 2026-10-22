import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { blobConfigured } from "@/lib/config";

/**
 * Where uploaded files live: Vercel Blob (private) when BLOB_READ_WRITE_TOKEN
 * is set, otherwise a local folder (development and tests only; refused on
 * Vercel, whose disk doesn't persist). Keys are "blob:<pathname>" or
 * "local:<relative path>", so the database records where each file is.
 */
const LOCAL_ROOT = path.join(process.cwd(), ".uploads");

export function storageBackend(): "vercel-blob" | "local" | "none" {
  if (blobConfigured()) return "vercel-blob";
  return process.env.VERCEL ? "none" : "local";
}

export function safeName(name: string): string {
  const base = path.basename(name).normalize("NFKD").replace(/[^\w.-]+/g, "-");
  return base.replace(/^-+|-+$/g, "").slice(-120) || "file";
}

export async function putFile(name: string, bytes: Buffer, contentType: string): Promise<string> {
  const pathname = `sources/${randomUUID()}/${safeName(name)}`;
  const backend = storageBackend();
  if (backend === "vercel-blob") {
    const { put } = await import("@vercel/blob");
    await put(pathname, bytes, { access: "private", contentType, addRandomSuffix: false });
    return `blob:${pathname}`;
  }
  if (backend === "local") {
    const file = path.join(LOCAL_ROOT, pathname);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return `local:${pathname}`;
  }
  throw new Error("File storage isn't set up: add Vercel Blob to the project (BLOB_READ_WRITE_TOKEN).");
}

function localPath(key: string): string {
  const rel = key.slice("local:".length);
  const file = path.resolve(LOCAL_ROOT, rel);
  if (!file.startsWith(LOCAL_ROOT + path.sep)) throw new Error("Invalid file key");
  return file;
}

export async function readStoredFile(key: string): Promise<Buffer> {
  if (key.startsWith("blob:")) {
    const { get } = await import("@vercel/blob");
    const res = await get(key.slice("blob:".length), { access: "private" });
    if (!res || res.statusCode !== 200) throw new Error("File not found in storage");
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  }
  if (key.startsWith("local:")) return readFile(localPath(key));
  throw new Error("Unknown file key");
}

export async function deleteStoredFile(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    if (key.startsWith("blob:")) {
      const { del } = await import("@vercel/blob");
      await del(key.slice("blob:".length));
    } else if (key.startsWith("local:")) {
      await rm(localPath(key), { force: true });
    }
  } catch (err) {
    console.warn("file not deleted", err instanceof Error ? err.message : err);
  }
}

/** Blob uploads made straight from the browser land under this prefix. */
export const CLIENT_UPLOAD_PREFIX = "sources/";
