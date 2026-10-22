import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Chat tokens: a visitor's chat is theirs because their browser holds a
 * random 32-byte token; the database only stores its SHA-256. The same
 * scheme serves invitation links.
 */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokensMatch(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A bearer token from "Authorization: Bearer …", or null. */
export function bearer(header: string | null): string | null {
  const m = header ? /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header.trim()) : null;
  return m ? m[1] : null;
}
