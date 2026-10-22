import "server-only";
import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

/**
 * Checks that a webhook really came from Neon Auth: an Ed25519 detached JWS
 * over "<timestamp>.<base64url(body)>", signed by a key from our Neon Auth
 * JWKS (https://neon.com/docs/auth/guides/webhooks#signature-verification).
 */
export type Jwk = JsonWebKey & { kid?: string };

export type SignatureHeaders = {
  signature: string | null;
  kid: string | null;
  timestamp: string | null;
};

const MAX_AGE_MS = 5 * 60_000;

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export function verifySignature(
  rawBody: string,
  h: SignatureHeaders,
  jwk: Jwk,
  now: number = Date.now(),
): boolean {
  if (!h.signature || !h.timestamp) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_AGE_MS) return false;
  const parts = h.signature.split(".");
  if (parts.length !== 3 || parts[1] !== "" || !parts[0] || !parts[2]) return false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    const signingInput = `${parts[0]}.${b64url(`${h.timestamp}.${b64url(rawBody)}`)}`;
    return verify(null, Buffer.from(signingInput), key, Buffer.from(parts[2], "base64url"));
  } catch {
    return false;
  }
}

let cache: { keys: Jwk[]; at: number } | null = null;

/** The signing keys, cached; refetched (at most once a minute) when a new key id turns up. */
export async function jwkFor(baseUrl: string, kid: string | null): Promise<Jwk | null> {
  if (!kid) return null;
  const fresh = cache && Date.now() - cache.at < 10 * 60_000;
  let key = fresh ? cache!.keys.find((k) => k.kid === kid) : undefined;
  if (key) return key;
  if (cache && Date.now() - cache.at < 60_000) return cache.keys.find((k) => k.kid === kid) ?? null;
  const res = await fetch(`${baseUrl}/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  cache = { keys: Array.isArray(body.keys) ? body.keys : [], at: Date.now() };
  key = cache.keys.find((k) => k.kid === kid);
  return key ?? null;
}
