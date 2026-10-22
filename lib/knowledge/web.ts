import "server-only";
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Fetching a web page for the knowledge base, safely. Staff type the
 * address, so it must not reach the server's own network: every connection
 * (and every redirect) is checked at connect time against private,
 * loopback, link-local and metadata addresses — including after DNS changes
 * (rebinding), because the check runs in the socket's own lookup. Pages are
 * capped at 5 MB and 15 seconds.
 */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/** True for addresses a fetch from our servers must never reach. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast and reserved
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("That isn't a web address. It should start with https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Only http and https addresses can be added.");
  }
  if (url.username || url.password)
    throw new UnsafeUrlError("Addresses with a password can't be added.");
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new UnsafeUrlError("Only standard web ports (80 and 443) are allowed.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("That address isn't on the public web.");
  }
  if (net.isIP(host) && isPrivateAddress(host)) {
    throw new UnsafeUrlError("That address isn't on the public web.");
  }
  return url;
}

/** DNS lookup that refuses private addresses, used by the socket itself. */
function safeLookup(
  hostname: string,
  options: object,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = (addresses as { address: string; family: number }[]) ?? [];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }), "");
    }
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

type Fetched = { url: string; contentType: string; body: string };

function getOnce(
  url: URL,
): Promise<{ status: number; location?: string; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get(
      url,
      {
        lookup: safeLookup as unknown as typeof dnsLookup,
        headers: {
          "user-agent": "BillieBot/1.0 (+knowledge base reader)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({
            status,
            location: res.headers.location,
            contentType: "",
            body: Buffer.alloc(0),
          });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new UnsafeUrlError("That page is over 5 MB."));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            status,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new UnsafeUrlError("That page took too long to load.")));
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EBLOCKED")
        reject(new UnsafeUrlError("That address isn't on the public web."));
      else
        reject(
          err instanceof UnsafeUrlError ? err : new UnsafeUrlError("That page couldn't be loaded."),
        );
    });
  });
}

export async function fetchPage(raw: string): Promise<Fetched> {
  let url = checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await getOnce(url);
    if (res.location) {
      url = checkUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status >= 400)
      throw new UnsafeUrlError(`That page answered with an error (${res.status}).`);
    if (!/text\/html|application\/xhtml|text\/plain/i.test(res.contentType)) {
      throw new UnsafeUrlError("That address isn't a web page. Upload the file itself instead.");
    }
    return { url: url.toString(), contentType: res.contentType, body: res.body.toString("utf8") };
  }
  throw new UnsafeUrlError("That page redirects too many times.");
}
