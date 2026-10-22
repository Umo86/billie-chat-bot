import { describe, expect, it } from "vitest";
import { frameAncestors, normaliseDomain } from "@/lib/chat/domains";
import { bearer, hashToken, newToken, tokensMatch } from "@/lib/chat/token";
import { initials, slugify, textOn, uniqueSlug } from "@/lib/bots/slug";

describe("allowed websites", () => {
  it("normalises what people type to a bare hostname", () => {
    expect(normaliseDomain("https://www.UKConstructionWeek.com/exhibit?x=1")).toBe("ukconstructionweek.com");
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
    expect(uniqueSlug("Exhibitor Help", ["exhibitor-help", "exhibitor-help-2"])).toBe("exhibitor-help-3");
  });

  it("picks readable text colours and initials", () => {
    expect(textOn("#0d6a5b")).toBe("#ffffff");
    expect(textOn("#f2c230")).toBe("#111111");
    expect(initials("Ask UKCW")).toBe("AU");
    expect(initials("billie")).toBe("BI");
  });
});
