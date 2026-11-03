import { cronAuthorised } from "@/lib/cron";

/**
 * Every minute (vercel.json): checks the event mailboxes and works through
 * queued jobs (reading files, drafting emails, alerts, WhatsApp). Most jobs
 * already ran straight after the request that queued them; this is the
 * safety net that retries failures and picks up anything left over.
 */
export const dynamic = "force-dynamic";
// Five minutes: a long job (the knowledge check) claimed near the end of the sweep still finishes.
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorised(request)) return new Response("Unauthorised", { status: 401 });
  const { minuteTick } = await import("@/lib/jobs/run");
  const result = await minuteTick();
  return Response.json({ ok: true, ...result });
}
