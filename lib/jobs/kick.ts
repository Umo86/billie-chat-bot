import "server-only";

/**
 * Start working on queued jobs straight after the current response is sent
 * (Next.js after()), so a file is read in seconds rather than at the next
 * cron sweep. Outside a request (scripts, tests) it does nothing: the cron
 * sweep or the test itself runs the queue.
 */
export async function kickJobs(): Promise<void> {
  try {
    const { after } = await import("next/server");
    after(async () => {
      const { runJobsNow } = await import("./run");
      await runJobsNow({ budgetMs: 55_000 });
    });
  } catch {
    // Not inside a request: nothing to schedule.
  }
}

let lastSweep = 0;
const SWEEP_EVERY_MS = 60_000;

/**
 * While the team is using Billie, pick up retries and anything left over
 * (at most once a minute per server instance). Cheap when nothing is due:
 * one indexed query. The every-minute Vercel Cron sweep
 * cover the hours when nobody is signed in.
 */
export async function sweepWhileBusy(now = Date.now()): Promise<void> {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  try {
    const { after } = await import("next/server");
    after(async () => {
      const { runJobsNow } = await import("./run");
      await runJobsNow({ budgetMs: 25_000 });
    });
  } catch {
    // Not inside a request.
  }
}
