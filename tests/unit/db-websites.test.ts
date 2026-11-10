import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobs, sources, websites } from "@/lib/db/schema";
import {
  addWebsite,
  crawlWebsite,
  queueWebsiteRecrawls,
  recrawlWebsite,
  removeWebsite,
  websitesFor,
} from "@/lib/knowledge/websites";
import { ingestSource } from "@/lib/knowledge/ingest";
import { sourcesFor } from "@/lib/knowledge/queries";
import { retrieve } from "@/lib/knowledge/search";
import { copyBot } from "@/lib/bots/copy";
import { answerBotFor, botById } from "@/lib/bots/load";
import { hasDb, makeBot, makeUser } from "../helpers/db";

/** A stand-in web: each test's site is its own; nothing leaves the machine. */
const web = vi.hoisted(() => new Map<string, { type: string; body: string }>());
vi.mock("@/lib/knowledge/web", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/knowledge/web")>();
  return {
    ...real,
    fetchPage: async (raw: string, opts: { kind?: "page" | "sitemap" | "robots" } = {}) => {
      const url = real.checkUrl(raw).toString();
      const page = web.get(url);
      if (!page) throw new real.UnsafeUrlError("That page answered with an error (404).");
      const want = { page: /html|plain/, sitemap: /xml|plain/, robots: /plain/ }[
        opts.kind ?? "page"
      ];
      if (!want.test(page.type)) throw new real.UnsafeUrlError("That address isn't a sitemap.");
      return { url, contentType: page.type, body: page.body };
    },
  };
});

const html = (title: string, text: string, links: string[] = []) => ({
  type: "text/html",
  body: `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join(" ")}</main></body></html>`,
});
const sitemap = (urls: string[]) => ({
  type: "application/xml",
  body: `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`,
});

async function pagesOf(websiteId: string) {
  return db
    .select()
    .from(sources)
    .where(and(eq(sources.websiteId, websiteId), isNull(sources.deletedAt)));
}

describe.skipIf(!hasDb)("whole websites (Postgres, stand-in web)", () => {
  it("“Read again now” picks up a changed agenda the same day, and says which page changed", async () => {
    const admin = await makeUser("admin");
    const { bot, kb } = await makeBot({ name: "Agenda Bot" });
    const site = `https://www.agenda-${randomUUID().slice(0, 6)}.test`;
    // No dates in the sitemap: nothing tells Billie which page changed.
    web.set(`${site}/sitemap.xml`, sitemap([`${site}/`, `${site}/agenda`]));
    web.set(`${site}/`, html("The Show", "Two days of talks at ExCeL London."));
    web.set(`${site}/agenda`, html("Agenda", "The keynote is at 10:00 on the Main Stage."));
    const id = await addWebsite(admin, kb.id, { url: `${site}/`, leaveOut: [], maxPages: 20 });
    await crawlWebsite(id);
    for (const p of await pagesOf(id)) await ingestSource(p.id);
    const ids = (await answerBotFor((await botById(bot.id))!)).knowledgeBaseIds;
    expect((await retrieve(ids, "When is the keynote?")).map((f) => f.text).join(" ")).toContain(
      "10:00",
    );
    let [row] = await websitesFor(kb.id);
    expect(row.pages.every((p) => p.lastReadAt && !p.changedAt)).toBe(true);

    // The agenda moves an hour later. The weekly look isn't due, so it would leave the page alone.
    web.set(`${site}/agenda`, html("Agenda", "The keynote is at 11:00 on the Main Stage."));
    const pages = await pagesOf(id);
    const queuedFor = async (sourceId: string) =>
      (
        await db
          .select()
          .from(jobs)
          .where(and(eq(jobs.dedupeKey, `ingest:${sourceId}`), eq(jobs.status, "queued")))
      ).length;
    await db.delete(jobs).where(like(jobs.dedupeKey, "ingest:%"));
    await crawlWebsite(id);
    for (const p of pages) expect(await queuedFor(p.id)).toBe(0);

    // The admin presses "Read again now": every page is read again.
    await recrawlWebsite(admin, id);
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, `crawl:${id}:all`));
    expect(job.payload).toMatchObject({ websiteId: id, all: true });
    await crawlWebsite(id, new Date(), { all: true });
    for (const p of pages) expect(await queuedFor(p.id)).toBe(1);
    for (const p of pages) await ingestSource(p.id);
    const after = (await retrieve(ids, "When is the keynote?")).map((f) => f.text).join(" ");
    expect(after).toContain("11:00");
    expect(after).not.toContain("10:00");
    // Only the agenda is marked as changed; the home page was read and found the same.
    [row] = await websitesFor(kb.id);
    const byUrl = Object.fromEntries(row.pages.map((p) => [p.url, p]));
    expect(byUrl[`${site}/agenda`].changedAt).toBeTruthy();
    expect(byUrl[`${site}/`].changedAt).toBeNull();
  });

  it("reads the pages in the sitemap robots.txt names, and keeps them up to date", async () => {
    const admin = await makeUser("admin");
    const { bot, kb } = await makeBot({ name: "Website Bot" });
    const site = `https://www.show-${randomUUID().slice(0, 6)}.test`;
    web.set(`${site}/robots.txt`, {
      type: "text/plain",
      body: `User-agent: *\nDisallow: /admin\nSitemap: ${site}/sitemap_index.xml`,
    });
    web.set(`${site}/sitemap_index.xml`, {
      type: "application/xml",
      body: `<sitemapindex><sitemap><loc>${site}/pages.xml</loc></sitemap><sitemap><loc>https://elsewhere.test/x.xml</loc></sitemap></sitemapindex>`,
    });
    web.set(
      `${site}/pages.xml`,
      sitemap([
        `${site}/`,
        `${site}/visit/travel`,
        `${site}/news/2026/a-story`,
        `${site}/admin/login`,
        `${site}/brochure.pdf`,
      ]),
    );
    web.set(`${site}/`, html("UK Show", "The UK's biggest trade show."));
    web.set(`${site}/visit/travel`, html("Travel", "Park in the orange car park, next to Hall 3."));

    const id = await addWebsite(admin, kb.id, {
      url: `${site}/`,
      leaveOut: ["/news"],
      maxPages: 50,
    });
    await expect(
      addWebsite(admin, kb.id, { url: `${site}/visit`, leaveOut: [], maxPages: 5 }),
    ).rejects.toThrow(/already in this knowledge/);
    await crawlWebsite(id);
    let pages = await pagesOf(id);
    expect(pages.map((p) => p.url).sort()).toEqual([`${site}/`, `${site}/visit/travel`]);
    const [row] = await websitesFor(kb.id);
    expect(row).toMatchObject({ status: "ready", note: "5 pages in the sitemap; reading 2." });
    expect(row.pages).toHaveLength(2);
    // Each page is read like a web page, spread out over time.
    const queued = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "ingest_source"), like(jobs.dedupeKey, "ingest:%")));
    expect(queued.filter((j) => pages.some((p) => j.dedupeKey === `ingest:${p.id}`))).toHaveLength(
      2,
    );
    for (const p of pages) await ingestSource(p.id);
    const ids = (await answerBotFor((await botById(bot.id))!)).knowledgeBaseIds;
    const found = await retrieve(ids, "Where is the car park?");
    expect(found.map((f) => f.text).join("\n")).toContain("orange car park");
    // The pages show on the website's card, not in the list of other sources.
    expect(await sourcesFor(kb.id)).toEqual([]);

    // A week on: the travel page has gone, a parking page is new, the home page is read again.
    web.set(`${site}/pages.xml`, sitemap([`${site}/`, `${site}/visit/parking`]));
    web.set(`${site}/visit/parking`, html("Parking", "Blue badge parking is by the north gate."));
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect(await queueWebsiteRecrawls(later)).toBeGreaterThanOrEqual(1);
    await crawlWebsite(id, later);
    pages = await pagesOf(id);
    expect(pages.map((p) => p.url).sort()).toEqual([`${site}/`, `${site}/visit/parking`]);
    const travel = await db.query.sources.findFirst({
      where: eq(sources.url, `${site}/visit/travel`),
    });
    expect(travel?.deletedAt).toBeTruthy(); // in the bin
    const home = pages.find((p) => p.url === `${site}/`)!;
    expect(
      await db
        .select()
        .from(jobs)
        .where(eq(jobs.dedupeKey, `ingest:${home.id}`)),
    ).not.toHaveLength(0);

    // A copy for next year's show keeps reading the website.
    const copyId = await copyBot(admin, bot.id, {
      name: `Copy ${randomUUID().slice(0, 4)}`,
      showName: "",
    });
    const copyKb = (await answerBotFor((await botById(copyId))!)).knowledgeBaseIds[0];
    const [copied] = await websitesFor(copyKb);
    expect(copied).toMatchObject({ host: row.host, leaveOut: ["/news"] });
    expect(copied.pages).toHaveLength(2);

    // Removed: the pages go to the bin with it.
    await removeWebsite(admin, id);
    expect(await pagesOf(id)).toHaveLength(0);
    expect(await websitesFor(kb.id)).toEqual([]);
    expect(await db.query.websites.findFirst({ where: eq(websites.id, id) })).toMatchObject({
      deletedAt: expect.any(Date),
    });
  });

  it("uses the home page's links when there's no sitemap, and says when nothing is found", async () => {
    const admin = await makeUser("admin");
    const { kb } = await makeBot({ name: "No Sitemap Bot" });
    const site = `https://shop-${randomUUID().slice(0, 6)}.test`;
    web.set(
      `${site}/`,
      html("Shop", "Welcome.", ["/faq", "/contact", "https://elsewhere.test/", "/faq#top"]),
    );
    const id = await addWebsite(admin, kb.id, { url: site, leaveOut: ["contact"], maxPages: 10 });
    await crawlWebsite(id);
    expect((await pagesOf(id)).map((p) => p.url).sort()).toEqual([`${site}/`, `${site}/faq`]);
    expect((await websitesFor(kb.id))[0].note).toMatch(/links on the home page \(no sitemap\)/);

    const gone = `https://gone-${randomUUID().slice(0, 6)}.test`;
    const missing = await addWebsite(admin, kb.id, { url: gone, leaveOut: [], maxPages: 10 });
    await crawlWebsite(missing);
    const failed = (await websitesFor(kb.id)).find((w) => w.id === missing)!;
    expect(failed).toMatchObject({
      status: "failed",
      note: "That page answered with an error (404). Check the address, then read it again.",
    });
  });

  it("never reads a website on the server's own network", async () => {
    const admin = await makeUser("admin");
    const { kb } = await makeBot();
    await expect(
      addWebsite(admin, kb.id, { url: "http://169.254.169.254/latest", leaveOut: [], maxPages: 5 }),
    ).rejects.toThrow(/isn't on the public web/);
  });
});
