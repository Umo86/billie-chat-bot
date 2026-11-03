import { describe, expect, it } from "vitest";
import { frameAncestors, normaliseDomain, sameOrigin } from "@/lib/chat/domains";
import { bearer, hashToken, newToken, tokensMatch } from "@/lib/chat/token";
import { initials, slugify, textOn, uniqueSlug } from "@/lib/bots/slug";

describe("allowed websites", () => {
  it("normalises what people type to a bare hostname", () => {
    expect(normaliseDomain("https://www.UKConstructionWeek.com/exhibit?x=1")).toBe(
      "ukconstructionweek.com",
    );
    expect(normaliseDomain("manual.example.co.uk:443")).toBe("manual.example.co.uk");
    expect(normaliseDomain("localhost")).toBe("localhost");
    expect(normaliseDomain("not a domain")).toBeNull();
    expect(normaliseDomain("javascript:alert(1)")).toBeNull();
    expect(normaliseDomain("")).toBeNull();
  });

  it("lets live bots appear on their websites and subdomains only", () => {
    expect(frameAncestors(["ukconstructionweek.com"], true)).toBe(
      "'self' https://ukconstructionweek.com https://*.ukconstructionweek.com",
    );
    expect(frameAncestors(["ukconstructionweek.com"], false)).toBe("'self'");
    expect(frameAncestors(["bad value; script-src *"], true)).toBe("'self'");
  });
});

describe("chat tokens", () => {
  it("stores only a hash and compares in constant time", () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(tokensMatch(t, h)).toBe(true);
    expect(tokensMatch(newToken(), h)).toBe(false);
  });

  it("reads bearer headers strictly", () => {
    const t = newToken();
    expect(bearer(`Bearer ${t}`)).toBe(t);
    expect(bearer("Bearer short")).toBeNull();
    expect(bearer(null)).toBeNull();
    expect(bearer(`Basic ${t}`)).toBeNull();
  });
});

describe("bot handles", () => {
  it("slugifies names and avoids taken handles", () => {
    expect(slugify("Exhibitor Help!")).toBe("exhibitor-help");
    expect(slugify("Café Bot")).toBe("cafe-bot");
    expect(slugify("!!!")).toBe("bot");
    expect(uniqueSlug("Exhibitor Help", ["exhibitor-help", "exhibitor-help-2"])).toBe(
      "exhibitor-help-3",
    );
  });

  it("picks readable text colours and initials", () => {
    expect(textOn("#0d6a5b")).toBe("#ffffff");
    expect(textOn("#f2c230")).toBe("#111111");
    expect(initials("Ask UKCW")).toBe("AU");
    expect(initials("billie")).toBe("BI");
  });
});

import { clientKey } from "@/lib/rate-limit";

describe("rate-limit identity", () => {
  it("keeps IPv4 as it is and groups IPv6 by its /64", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("2a00:23c7:abcd:1200:1:2:3:4")).toBe("2a00:23c7:abcd:1200::/64");
    expect(clientKey("2a00:23c7:abcd:1200::99")).toBe("2a00:23c7:abcd:1200::/64");
    expect(clientKey("2a00:23c7::1")).toBe("2a00:23c7:0:0::/64");
  });
});

describe("writes to the public chat", () => {
  const post = (
    origin: string | null,
    url = "https://billie-teal.vercel.app/api/public/chat/x/messages",
  ) =>
    new Request(url, {
      method: "POST",
      headers: origin ? { origin, host: new URL(url).host } : { host: new URL(url).host },
    });

  it("come only from the chat's own pages", () => {
    expect(sameOrigin(post("https://billie-teal.vercel.app"))).toBe(true);
    // A preview or deployment address of the same app is its own page too.
    expect(
      sameOrigin(post("https://billie-abc.vercel.app", "https://billie-abc.vercel.app/api/x")),
    ).toBe(true);
    expect(sameOrigin(post("https://evil.example"))).toBe(false);
    expect(sameOrigin(post("https://billie-teal.vercel.app.evil.example"))).toBe(false);
    expect(sameOrigin(post("null"))).toBe(false); // a sandboxed frame or a file
    expect(sameOrigin(post(null))).toBe(true); // not a browser page: the rate limits still apply
  });
});
