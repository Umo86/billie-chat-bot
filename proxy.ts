import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs before staff pages: Neon Auth's middleware checks the session and
 * refreshes its cookies, sending signed-out people to /login. The pages
 * then decide what the person may do (lib/auth/actor.ts). Public pages
 * (the chat widget, webhooks, sign-in) never come through here.
 */
const STAFF_PAGE = /^\/(?:$|bots|knowledge|inbox|emails|try|reports|settings)(?:\/|$)/;

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

export async function proxy(request: NextRequest) {
  if (STAFF_PAGE.test(request.nextUrl.pathname)) return staffSession(request);
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
  ],
};
