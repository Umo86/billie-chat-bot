import { parseHTML } from "linkedom";

/**
 * Finding a website's pages (pure): from its sitemap (or sitemap index),
 * or else from the links on its home page; keeping only pages on the same
 * site that robots.txt lets us read and the team hasn't left out.
 */

export type FoundPage = { url: string; lastmod: string | null };

/** Most pages one website may have read. */
export const MAX_PAGES = 500;
/** Most sitemaps read for one website (an index can list many). */
export const MAX_SITEMAPS = 10;

/** Most addresses taken from one sitemap, and the longest address kept. */
export const MAX_LOCS = MAX_PAGES * 4;
const MAX_URL = 2048;
/** Most robots.txt rules and sitemaps kept, and links taken from a home page. */
const MAX_RULES = 1000;
const MAX_ROBOTS_SITEMAPS = 50;
const MAX_LINKS = MAX_PAGES * 4;

/** Entities and a CDATA wrapper, without regular expressions that can backtrack. */
function decode(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("<![CDATA[") && s.endsWith("]]>")) s = s.slice(9, -3).trim();
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Lower-cases A-Z only, so every position still matches the original text. */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * What's inside each <tag>…</tag> (with or without attributes, but not a
 * longer name: <url> isn't <urlset>), in order, at most `max`. One pass with
 * indexOf, never going back: a hostile sitemap (thousands of tags that never
 * close) can't make it slow.
 */
function inside(text: string, tag: string, max: number, lower = asciiLower(text)): string[] {
  const out: string[] = [];
  const open = `<${tag}`;
  const close = `</${tag}`;
  let from = 0;
  while (out.length < max) {
    const at = lower.indexOf(open, from);
    if (at < 0) break;
    const next = lower[at + open.length] ?? "";
    if (next !== ">" && next !== "/" && !/\s/.test(next)) {
      from = at + open.length; // a longer name
      continue;
    }
    const gt = lower.indexOf(">", at + open.length);
    if (gt < 0) break;
    if (lower[gt - 1] === "/") {
      from = gt + 1; // <tag/>: nothing inside
      continue;
    }
    const end = lower.indexOf(close, gt + 1);
    if (end < 0) break;
    out.push(text.slice(gt + 1, end));
    from = end + close.length;
  }
  return out;
}

/** The address in a <url> or <sitemap> block, if it has a usable one. */
function locIn(block: string, lower: string): string | null {
  const [loc] = inside(block, "loc", 1, lower);
  if (loc === undefined || loc.length > MAX_URL + 100) return null;
  const url = decode(loc);
  return url && url.length <= MAX_URL ? url : null;
}

/** The pages and child sitemaps in a sitemap or sitemap index. */
export function parseSitemap(xml: string): { pages: FoundPage[]; sitemaps: string[] } {
  const lower = asciiLower(xml);
  const sitemaps: string[] = [];
  for (const block of inside(xml, "sitemap", MAX_SITEMAPS * 5, lower)) {
    const url = locIn(block, asciiLower(block));
    if (url) sitemaps.push(url);
  }
  const pages: FoundPage[] = [];
  for (const block of inside(xml, "url", MAX_LOCS, lower)) {
    const blockLower = asciiLower(block);
    const url = locIn(block, blockLower);
    if (!url) continue;
    const [lastmod] = inside(block, "lastmod", 1, blockLower);
    pages.push({ url, lastmod: lastmod ? decode(lastmod).slice(0, 40) : null });
  }
  return { pages, sitemaps };
}

/** What robots.txt says for us: its sitemaps, and the paths it keeps us out of. */
export function readRobots(text: string): {
  sitemaps: string[];
  rules: { allow: boolean; path: string }[];
} {
  const sitemaps: string[] = [];
  const rules: { allow: boolean; path: string }[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "sitemap") {
      if (value && sitemaps.length < MAX_ROBOTS_SITEMAPS) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      // A new group starts with the first user-agent line after some rules.
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
      continue;
    }
    if (key === "allow" || key === "disallow") {
      inRules = true;
      const forUs = agents.some((a) => a === "*" || a.startsWith("billiebot"));
      if (forUs && value && rules.length < MAX_RULES)
        rules.push({ allow: key === "allow", path: value.slice(0, MAX_URL) });
    }
  }
  return { sitemaps, rules };
}

/** Can we read this path? The longest matching rule decides (as Google does). */
export function robotsAllow(rules: { allow: boolean; path: string }[], path: string): boolean {
  let best: { allow: boolean; path: string } | null = null;
  for (const r of rules) {
    const prefix = r.path.replace(/\*.*$/, "").replace(/\$$/, "");
    if (path.startsWith(prefix) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best ? best.allow : true;
}

/** Links on a page, as full addresses (read with a real HTML parser, so it's never slow). */
export function linksIn(html: string, base: string): string[] {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const out: string[] = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (out.length >= MAX_LINKS) break;
    const href = (a.getAttribute("href") ?? "").trim();
    if (!href || href.length > MAX_URL) continue;
    try {
      out.push(new URL(href, base).toString());
    } catch {
      // not an address
    }
  }
  return out;
}

/** Files and things that aren't pages to read. */
const NOT_A_PAGE =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|gz|docx?|xlsx?|pptx?|csv|mp4|mov|mp3|wav|css|js|json|xml|rss|ics)$/i;

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

/**
 * The pages to read: on the same site (with or without www), web pages only,
 * no fragments, each once, allowed by robots.txt, not left out by the team,
 * at most `max`. Sitemap order is kept (sites list their main pages first).
 */
export function pickPages(
  found: FoundPage[],
  opts: {
    host: string;
    leaveOut: string[];
    rules?: { allow: boolean; path: string }[];
    max: number;
  },
): FoundPage[] {
  const host = bareHost(opts.host);
  const leaveOut = opts.leaveOut.map((w) => w.trim().toLowerCase()).filter(Boolean);
  const seen = new Set<string>();
  const out: FoundPage[] = [];
  for (const p of found) {
    let url: URL;
    try {
      url = new URL(p.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (bareHost(url.hostname) !== host) continue;
    if (url.username || url.password) continue;
    if (NOT_A_PAGE.test(url.pathname)) continue;
    url.hash = "";
    const key = `${bareHost(url.hostname)}${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`;
    if (seen.has(key)) continue;
    const address = url.toString().toLowerCase();
    if (leaveOut.some((w) => address.includes(w))) continue;
    if (opts.rules && !robotsAllow(opts.rules, url.pathname)) continue;
    seen.add(key);
    out.push({ url: url.toString(), lastmod: p.lastmod });
    if (out.length >= opts.max) break;
  }
  return out;
}

/** "news, /press" or one per line → ["news", "/press"] */
export function leaveOutList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 30);
}
