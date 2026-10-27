import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

/**
 * Staff pages before sign-in is fully set up: the proxy must let the request
 * through so the page can say what's missing, never fail with a server error
 * (the pages' own requireActor() check still decides who gets in).
 */
describe("proxy on staff pages", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lets the page explain a missing cookie secret instead of failing", async () => {
    vi.stubEnv("NEON_AUTH_BASE_URL", "https://ep-x.neonauth.eu-west-2.aws.neon.tech/neondb/auth");
    vi.stubEnv("NEON_AUTH_COOKIE_SECRET", "too-short");
    for (const path of ["/", "/settings", "/inbox"]) {
      const response = await proxy(new NextRequest(`https://billie.test${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("passes staff pages through when sign-in isn't configured at all", async () => {
    vi.stubEnv("NEON_AUTH_BASE_URL", "");
    vi.stubEnv("BILLIE_LOCAL_AUTH", "");
    const response = await proxy(new NextRequest("https://billie.test/bots/new"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
