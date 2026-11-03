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

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();

/** The pages and child sitemaps in a sitemap or sitemap index. */
export function parseSitemap(xml: string): { pages: FoundPage[]; sitemaps: string[] } {
  const pages: FoundPage[] = [];
  const sitemaps: string[] = [];
  const block = /<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of xml.matchAll(block)) {
    const loc = /<loc\b[^>]*>([\s\S]*?)<\/loc>/i.exec(m[2])?.[1];
    if (!loc) continue;
    const url = decode(loc);
    if (m[1].toLowerCase() === "sitemap") sitemaps.push(url);
    else {
      const lastmod = /<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i.exec(m[2])?.[1];
      pages.push({ url, lastmod: lastmod ? decode(lastmod) : null });
    }
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
      if (value) sitemaps.push(value);
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
      if (forUs && value) rules.push({ allow: key === "allow", path: value });
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

/** Links on a page, as full addresses. */
export function linksIn(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    try {
      out.push(new URL(decode(m[2]), base).toString());
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
