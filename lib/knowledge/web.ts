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

function privateV4(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF and TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast and reserved
  );
}

/** An IPv6 address as eight 16-bit groups, or null if it isn't one. */
function groupsV6(ip: string): number[] | null {
  let v = ip.toLowerCase().split("%")[0];
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    v =
      v.slice(0, -dotted[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const all = [...left, ...new Array(Math.max(0, fill)).fill("0"), ...right];
  if (all.length !== 8) return null;
  const nums = all.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** True for addresses a fetch from our servers must never reach. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  if (!net.isIPv6(ip.split("%")[0])) return true;
  const g = groupsV6(ip);
  if (!g) return true;
  const zero = (n: number) => g.slice(0, n).every((x) => x === 0);
  const v4 = (i: number) => `${g[i] >> 8}.${g[i] & 255}.${g[i + 1] >> 8}.${g[i + 1] & 255}`;
  if (zero(8) || (zero(7) && g[7] === 1)) return true; // :: and ::1
  if (zero(5) && g[5] === 0xffff) return privateV4(v4(6)); // IPv4-mapped
  if (zero(6)) return true; // IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] !== 0 || privateV4(v4(6)); // NAT64
  if (g[0] === 0x2002) return privateV4(v4(1)); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && zero(4)) return true; // discard
  return (
    (g[0] & 0xfe00) === 0xfc00 || // unique local
    (g[0] & 0xffc0) === 0xfe80 || // link-local
    (g[0] & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (g[0] & 0xff00) === 0xff00 // multicast
  );
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
        clearTimeout(deadline);
        deadline = setTimeout(
          () => req.destroy(new UnsafeUrlError("That page took too long to load.")),
          TIMEOUT_MS,
        );
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
    // The whole request, not just idle time, has a deadline.
    let deadline = setTimeout(
      () => req.destroy(new UnsafeUrlError("That page took too long to load.")),
      TIMEOUT_MS,
    );
    req.on("close", () => clearTimeout(deadline));
    // Check where the socket actually connected, so an address that skipped
    // the lookup (a literal IP in any spelling) is still refused.
    req.on("socket", (socket) => {
      socket.once("connect", () => {
        const remote = socket.remoteAddress;
        if (!remote || isPrivateAddress(remote))
          req.destroy(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
      });
    });
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
