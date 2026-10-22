import { authMode, neonAuthBaseUrl } from "@/lib/auth/config";
import { jwkFor, verifySignature } from "@/lib/auth/webhook";
import { signUpAllowed } from "@/lib/team/accounts";

/**
 * Neon Auth's "user.before_create" check: Billie is invite-only, so a new
 * sign-in can only be made for an email with an open invitation (or, on
 * first run, FIRST_ADMIN_EMAIL). Neon fails closed: if this can't answer,
 * the sign-up is refused. Configure it in the Neon Console under Auth →
 * Configuration → Webhooks with the "user.before_create" event.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const baseUrl = neonAuthBaseUrl();
  if (authMode() !== "neon" || !baseUrl) return new Response("Not found", { status: 404 });
  const raw = await request.text();
  if (raw.length > 64_000) return new Response("Too large", { status: 413 });

  const h = {
    signature: request.headers.get("x-neon-signature"),
    kid: request.headers.get("x-neon-signature-kid"),
    timestamp: request.headers.get("x-neon-timestamp"),
  };
  let jwk;
  try {
    jwk = await jwkFor(baseUrl, h.kid);
  } catch (err) {
    console.error("neon auth webhook: keys unavailable", err instanceof Error ? err.message : err);
    return new Response("Keys unavailable", { status: 503 });
  }
  if (!jwk || !verifySignature(raw, h, jwk)) return new Response("Bad signature", { status: 401 });

  let event: { event_type?: string; user?: { email?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  if (event.event_type === "user.before_create") {
    const email = event.user?.email ?? "";
    const allowed = email ? await signUpAllowed(email) : false;
    return Response.json(
      allowed
        ? { allowed: true }
        : {
            allowed: false,
            error_message: "Billie is invite-only. Ask an admin to invite you.",
            error_code: "NOT_INVITED",
          },
    );
  }
  return Response.json({ received: true });
}
