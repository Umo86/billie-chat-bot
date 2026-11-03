import { describe, expect, it } from "vitest";
import {
  leaveOutList,
  linksIn,
  parseSitemap,
  pickPages,
  readRobots,
  robotsAllow,
} from "@/lib/knowledge/sitemap";

describe("finding a website's pages", () => {
  it("reads sitemaps and sitemap indexes", () => {
    const set = parseSitemap(`<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://www.show.test/</loc></url>
        <url><loc> https://www.show.test/visit/travel?a=1&amp;b=2 </loc><lastmod>2026-10-01</lastmod></url>
        <url><loc><![CDATA[https://www.show.test/exhibit]]></loc></url>
      </urlset>`);
    expect(set.pages).toEqual([
      { url: "https://www.show.test/", lastmod: null },
      { url: "https://www.show.test/visit/travel?a=1&b=2", lastmod: "2026-10-01" },
      { url: "https://www.show.test/exhibit", lastmod: null },
    ]);
    expect(set.sitemaps).toEqual([]);
    const index = parseSitemap(
      `<sitemapindex><sitemap><loc>https://www.show.test/pages.xml</loc></sitemap></sitemapindex>`,
    );
    expect(index).toEqual({ pages: [], sitemaps: ["https://www.show.test/pages.xml"] });
  });

  it("follows robots.txt: our rules, the longest match deciding, and its sitemaps", () => {
    const robots = readRobots(
      [
        "User-agent: Googlebot",
        "Disallow: /",
        "",
        "User-agent: *",
        "Disallow: /admin",
        "Allow: /admin/help # a public page",
        "Disallow:",
        "Sitemap: https://www.show.test/sitemap_index.xml",
      ].join("\n"),
    );
    expect(robots.sitemaps).toEqual(["https://www.show.test/sitemap_index.xml"]);
    expect(robotsAllow(robots.rules, "/visit")).toBe(true);
    expect(robotsAllow(robots.rules, "/admin/users")).toBe(false);
    expect(robotsAllow(robots.rules, "/admin/help")).toBe(true);
  });

  it("finds links on a page", () => {
    expect(
      linksIn(
        `<a href="/visit">Visit</a> <a class="x" href='https://other.test/a'>x</a> <a href="mailto:a@b.test">m</a>`,
        "https://www.show.test/",
      ),
    ).toEqual(["https://www.show.test/visit", "https://other.test/a", "mailto:a@b.test"]);
  });

  it("keeps only this site's pages, once each, minus what's left out", () => {
    const found = [
      "https://www.show.test/",
      "https://show.test/visit/travel", // the same site without www
      "https://www.show.test/visit/travel/", // the same page again
      "https://www.show.test/visit/travel#parking",
      "https://www.show.test/news/2026/a-story",
      "https://www.show.test/brochure.pdf",
      "https://www.show.test/admin/login",
      "https://other.test/elsewhere",
      "mailto:info@show.test",
      "https://www.show.test/exhibit",
      "https://www.show.test/exhibit/deliveries",
    ].map((url) => ({ url, lastmod: null }));
    const picked = pickPages(found, {
      host: "show.test",
      leaveOut: leaveOutList("/News\n, /press"),
      rules: [{ allow: false, path: "/admin" }],
      max: 3,
    });
    expect(picked.map((p) => p.url)).toEqual([
      "https://www.show.test/",
      "https://show.test/visit/travel",
      "https://www.show.test/exhibit",
    ]);
    expect(leaveOutList(" /news, /NEWS\n/press ")).toEqual(["/news", "/press"]);
  });
});
