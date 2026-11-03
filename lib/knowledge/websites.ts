import "server-only";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { knowledgeBases, sources, websites } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import type { Actor } from "@/lib/authz";
import { checkUrl, fetchPage, UnsafeUrlError } from "./web";
import {
  linksIn,
  MAX_PAGES,
  MAX_SITEMAPS,
  parseSitemap,
  pickPages,
  readRobots,
  type FoundPage,
} from "./sitemap";

/**
 * A whole website in a bot's knowledge. Billie finds its pages (the sitemap
 * that robots.txt names, or /sitemap.xml, or else the home page's links),
 * keeps those on the same site that robots.txt allows and the team hasn't
 * left out, up to a limit, and reads each as a web page. Every week it looks
 * again: new pages are added, pages that have gone are taken out (to the
 * bin), and pages that changed (by the sitemap's date, or a week on) are
 * read again. Every fetch goes through the safe fetcher (lib/knowledge/web.ts).
 */

export type WebsiteInput = { url: string; leaveOut: string[]; maxPages: number };

const WEEK = 7 * 86_400_000;
const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");

async function kbOf(kbId: string) {
  const kb = await db.query.knowledgeBases.findFirst({
    where: and(eq(knowledgeBases.id, kbId), isNull(knowledgeBases.deletedAt)),
  });
  if (!kb) throw new UserError("That knowledge base no longer exists.");
  return kb;
}

function cleanInput(input: WebsiteInput) {
  const url = checkUrl(input.url);
  url.hash = "";
  return {
    url: url.toString(),
    host: bare(url.hostname),
    leaveOut: input.leaveOut.map((w) => w.trim().toLowerCase().slice(0, 100)).filter(Boolean),
    maxPages: Math.min(Math.max(1, Math.round(input.maxPages)), MAX_PAGES),
  };
}

export async function addWebsite(actor: Actor, kbId: string, input: WebsiteInput): Promise<string> {
  const kb = await kbOf(kbId);
  const site = cleanInput(input);
  const id = await db.transaction(async (tx) => {
    const [same] = await tx
      .select({ id: websites.id })
      .from(websites)
      .where(
        and(
          eq(websites.knowledgeBaseId, kb.id),
          eq(websites.host, site.host),
          isNull(websites.deletedAt),
        ),
      );
    if (same)
      throw new UserError(
        "That website is already in this knowledge. Read it again from its card.",
      );
    const [row] = await tx
      .insert(websites)
      .values({ knowledgeBaseId: kb.id, ...site, addedBy: actor.id })
      .returning({ id: websites.id });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "website",
      entityId: row.id,
      action: "create",
      summary: `Added the website ${site.host} to ${kb.name}`,
    });
    await enqueue("crawl_website", { websiteId: row.id }, { tx, dedupeKey: `crawl:${row.id}` });
    return row.id;
  });
  await kickJobs({ long: true });
  return id;
}

/** What's left out and how many pages: saved, then the website is looked at again. */
export async function updateWebsite(
  actor: Actor,
  id: string,
  input: Omit<WebsiteInput, "url">,
): Promise<void> {
  const leaveOut = input.leaveOut.map((w) => w.trim().toLowerCase().slice(0, 100)).filter(Boolean);
  const maxPages = Math.min(Math.max(1, Math.round(input.maxPages)), MAX_PAGES);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(websites)
      .set({ leaveOut, maxPages })
      .where(and(eq(websites.id, id), isNull(websites.deletedAt)))
      .returning({ id: websites.id, host: websites.host });
    if (!row) throw new UserError("That website is no longer in this knowledge.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "website",
      entityId: id,
      action: "update",
      summary: `Changed which pages of ${row.host} Billie reads`,
    });
    await enqueue("crawl_website", { websiteId: id }, { tx, dedupeKey: `crawl:${id}` });
  });
  await kickJobs({ long: true });
}

export async function recrawlWebsite(actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(websites)
      .set({ status: "finding" })
      .where(and(eq(websites.id, id), isNull(websites.deletedAt)))
      .returning({ host: websites.host });
    if (!row) throw new UserError("That website is no longer in this knowledge.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "website",
      entityId: id,
      action: "update",
      summary: `Asked Billie to read ${row.host} again`,
    });
    await enqueue("crawl_website", { websiteId: id }, { tx, dedupeKey: `crawl:${id}` });
  });
  await kickJobs({ long: true });
}

/** The website and its pages go to the bin; a page restored from there stands on its own. */
export async function removeWebsite(actor: Actor, id: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(websites)
      .set({ deletedAt: now })
      .where(and(eq(websites.id, id), isNull(websites.deletedAt)))
      .returning({ host: websites.host });
    if (!row) return;
    const gone = await tx
      .update(sources)
      .set({ deletedAt: now, websiteId: null })
      .where(and(eq(sources.websiteId, id), isNull(sources.deletedAt)))
      .returning({ id: sources.id });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "website",
      entityId: id,
      action: "delete",
      summary: `Removed the website ${row.host} (${gone.length} ${gone.length === 1 ? "page" : "pages"} in the bin for 30 days)`,
    });
  });
}

/** Finding the pages: sitemaps first, the home page's links if there are none. */
async function discover(site: { url: string; host: string }) {
  const start = new URL(site.url);
  const origin = start.origin;
  const robots = await fetchPage(`${origin}/robots.txt`, { kind: "robots" })
    .then((r) => readRobots(r.body))
    .catch(() => ({ sitemaps: [] as string[], rules: [] }));
  const sameSite = (u: string) => {
    try {
      return bare(new URL(u).hostname) === site.host;
    } catch {
      return false;
    }
  };
  const queue = /\.xml(\.gz)?$/i.test(start.pathname)
    ? [start.toString()]
    : robots.sitemaps.filter(sameSite).length
      ? robots.sitemaps.filter(sameSite)
      : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const pages: FoundPage[] = [];
  const read = new Set<string>();
  while (queue.length && read.size < MAX_SITEMAPS && pages.length < MAX_PAGES * 4) {
    const next = queue.shift()!;
    if (read.has(next) || /\.gz$/i.test(next)) continue;
    read.add(next);
    try {
      const xml = (await fetchPage(next, { kind: "sitemap" })).body;
      const found = parseSitemap(xml);
      pages.push(...found.pages);
      queue.push(...found.sitemaps.filter(sameSite));
    } catch {
      // No sitemap there: try the next one, or the home page.
    }
  }
  if (pages.length) return { pages, robots, how: "sitemap" as const };
  const home = await fetchPage(start.toString());
  const links = linksIn(home.body, home.url).map((url) => ({ url, lastmod: null }));
  return {
    pages: [{ url: home.url, lastmod: null }, ...links],
    robots,
    how: "links" as const,
  };
}

/** The "crawl_website" job. */
export async function crawlWebsite(websiteId: string, now = new Date()): Promise<void> {
  const site = await db.query.websites.findFirst({
    where: and(eq(websites.id, websiteId), isNull(websites.deletedAt)),
  });
  if (!site) return;
  const fail = (note: string) =>
    db
      .update(websites)
      .set({ status: "failed", note, lastCrawledAt: now })
      .where(eq(websites.id, websiteId));
  let found: Awaited<ReturnType<typeof discover>>;
  try {
    found = await discover(site);
  } catch (err) {
    if (err instanceof UnsafeUrlError)
      return void (await fail(`${err.message} Check the address, then read it again.`));
    throw err; // tried again shortly
  }
  const picked = pickPages(found.pages, {
    host: site.host,
    leaveOut: site.leaveOut,
    rules: found.robots.rules,
    max: site.maxPages,
  });
  if (!picked.length)
    return void (await fail("No pages found to read. Check the address, and what's left out."));
  const how =
    found.how === "sitemap"
      ? `${found.pages.length} ${found.pages.length === 1 ? "page" : "pages"} in the sitemap`
      : `${found.pages.length} links on the home page (no sitemap)`;
  const note = `${how}; reading ${picked.length}${picked.length >= site.maxPages ? ` (the most set for this website)` : ""}.`;

  let added = 0;
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(sources)
      .where(and(eq(sources.websiteId, site.id), isNull(sources.deletedAt)));
    const byUrl = new Map(existing.map((s) => [s.url ?? "", s]));
    const keep = new Set(picked.map((p) => p.url));
    // Gone from the site (or now left out): to the bin.
    const gone = existing.filter((s) => !keep.has(s.url ?? "")).map((s) => s.id);
    if (gone.length)
      await tx
        .update(sources)
        .set({ deletedAt: now, websiteId: null })
        .where(inArray(sources.id, gone));
    let i = 0;
    for (const p of picked) {
      const had = byUrl.get(p.url);
      // Spread out, so the show's website gets a page every second or so, not all at once.
      const runAt = new Date(now.getTime() + i * 1500);
      if (!had) {
        const [row] = await tx
          .insert(sources)
          .values({
            knowledgeBaseId: site.knowledgeBaseId,
            kind: "web",
            title: p.url,
            url: p.url,
            status: "queued",
            websiteId: site.id,
            addedBy: site.addedBy,
          })
          .returning({ id: sources.id });
        await enqueue(
          "ingest_source",
          { sourceId: row.id },
          { tx, runAt, dedupeKey: `ingest:${row.id}` },
        );
        added++;
        i++;
        continue;
      }
      const changed =
        p.lastmod && had.lastReadAt && Date.parse(p.lastmod) > had.lastReadAt.getTime();
      const stale = !had.lastReadAt || now.getTime() - had.lastReadAt.getTime() >= WEEK;
      if (changed || stale || had.status === "failed") {
        await enqueue(
          "ingest_source",
          { sourceId: had.id },
          { tx, runAt, dedupeKey: `ingest:${had.id}` },
        );
        i++;
      }
    }
    await tx
      .update(websites)
      .set({ status: "ready", note, found: found.pages.length, lastCrawledAt: now })
      .where(eq(websites.id, site.id));
    if (added || gone.length)
      await writeAudit(tx, {
        actorType: "system",
        entityType: "website",
        entityId: site.id,
        action: "update",
        summary: `Read ${site.host}: ${added} new ${added === 1 ? "page" : "pages"}, ${gone.length} gone`,
      });
  });
}

/** Daily: websites last looked at a week ago or more. */
export async function queueWebsiteRecrawls(now = new Date()): Promise<number> {
  const due = await db
    .select({ id: websites.id })
    .from(websites)
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, websites.knowledgeBaseId))
    .where(
      and(
        isNull(websites.deletedAt),
        isNull(knowledgeBases.deletedAt),
        or(
          isNull(websites.lastCrawledAt),
          lt(websites.lastCrawledAt, new Date(now.getTime() - WEEK)),
        ),
      ),
    )
    .limit(100);
  for (const w of due)
    await enqueue("crawl_website", { websiteId: w.id }, { dedupeKey: `crawl:${w.id}` });
  return due.length;
}

export type WebsitePage = {
  id: string;
  title: string;
  url: string;
  status: "queued" | "reading" | "ready" | "failed";
  error: string | null;
};

export type WebsiteRow = {
  id: string;
  url: string;
  host: string;
  leaveOut: string[];
  maxPages: number;
  status: "finding" | "ready" | "failed";
  note: string;
  lastCrawledAt: string | null;
  pages: WebsitePage[];
};

/** A knowledge base's websites, with their pages. */
export async function websitesFor(kbId: string): Promise<WebsiteRow[]> {
  const list = await db
    .select()
    .from(websites)
    .where(and(eq(websites.knowledgeBaseId, kbId), isNull(websites.deletedAt)))
    .orderBy(asc(websites.createdAt));
  if (!list.length) return [];
  const pages = await db
    .select({
      id: sources.id,
      websiteId: sources.websiteId,
      title: sources.title,
      url: sources.url,
      status: sources.status,
      error: sources.error,
    })
    .from(sources)
    .where(
      and(
        inArray(
          sources.websiteId,
          list.map((w) => w.id),
        ),
        isNull(sources.deletedAt),
      ),
    )
    .orderBy(sql`${sources.status} = 'failed' DESC`, asc(sources.url));
  return list.map((w) => ({
    id: w.id,
    url: w.url,
    host: w.host,
    leaveOut: w.leaveOut,
    maxPages: w.maxPages,
    status: w.status,
    note: w.note,
    lastCrawledAt: w.lastCrawledAt?.toISOString() ?? null,
    pages: pages
      .filter((p) => p.websiteId === w.id)
      .map((p) => ({
        id: p.id,
        title: p.title,
        url: p.url ?? "",
        status: p.status,
        error: p.error,
      })),
  }));
}
