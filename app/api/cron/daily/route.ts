import { cronAuthorised } from "@/lib/cron";

/** Once a day (vercel.json): retention deletes, re-reading web pages, Monday's summary. */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorised(request)) return new Response("Unauthorised", { status: 401 });
  const { dailyTick, runJobsNow } = await import("@/lib/jobs/run");
  await dailyTick();
  const result = await runJobsNow({ budgetMs: 250_000 });
  return Response.json({ ok: true, ...result });
}
