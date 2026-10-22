import { NextResponse, type NextRequest } from "next/server";
import { cspWithAncestors } from "@/lib/csp";

/**
 * Runs before two kinds of page:
 *
 * - Staff pages: Neon Auth's middleware checks the session and refreshes its
 *   cookies, sending signed-out people to /login. The pages then decide what
 *   the person may do (lib/auth/actor.ts).
 * - The chat frame (/embed/<bot>): its Content-Security-Policy says which
 *   websites may show it (frame-ancestors), from the bot's allowed websites.
 */
const STAFF_PAGE = /^\/(?:$|bots|knowledge|inbox|emails|try|reports|settings)(?:\/|$)/;
const EMBED = /^\/embed\/([a-z0-9][a-z0-9-]{0,62})\/?$/;

type Middleware = (request: NextRequest) => Promise<NextResponse>;
let neonMiddleware: Middleware | undefined;

async function staffSession(request: NextRequest): Promise<NextResponse> {
  if (!process.env.NEON_AUTH_BASE_URL?.trim()) return NextResponse.next();
  if (!neonMiddleware) {
    const { neonAuth } = await import("@/lib/auth/neon");
    neonMiddleware = neonAuth().middleware({ loginUrl: "/login" });
  }
  const response = await neonMiddleware(request);
  // A form posted after the session ended gets the action's own "sign in
  // again" message, not a redirect it can't follow.
  if (response.headers.get("location") && request.headers.get("next-action"))
    return NextResponse.next();
  return response;
}

const policies = new Map<string, { csp: string; at: number }>();
const POLICY_TTL_MS = 30_000;

async function chatFrame(slug: string): Promise<NextResponse> {
  let hit = policies.get(slug);
  if (!hit || Date.now() - hit.at > POLICY_TTL_MS) {
    let ancestors = "'self'";
    try {
      const { frameAncestorsFor } = await import("@/lib/chat/frame-policy");
      ancestors = await frameAncestorsFor(slug);
    } catch (err) {
      console.error("frame policy unavailable", err instanceof Error ? err.message : err);
    }
    hit = { csp: cspWithAncestors(ancestors), at: Date.now() };
    if (policies.size > 500) policies.clear();
    policies.set(slug, hit);
  }
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", hit.csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  return response;
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const embed = EMBED.exec(path);
  if (embed) return chatFrame(embed[1]);
  if (STAFF_PAGE.test(path)) return staffSession(request);
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/bots/:path*",
    "/knowledge/:path*",
    "/inbox/:path*",
    "/emails/:path*",
    "/try/:path*",
    "/reports/:path*",
    "/settings/:path*",
    "/embed/:path*",
  ],
};
