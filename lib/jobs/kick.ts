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
