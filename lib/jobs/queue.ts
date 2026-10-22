import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, query, type DbOrTx } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";

/**
 * Background jobs in Postgres: no extra service to run or pay for. A job is
 * claimed with FOR UPDATE SKIP LOCKED (so two workers never take the same
 * one) under a lease; a worker that dies leaves the lease to run out and the
 * job is retried. Failures back off exponentially; after max attempts the
 * job stays "failed" for a person to see. Work is kicked straight after the
 * request that queued it (lib/jobs/kick.ts) and swept every minute by
 * Vercel Cron (/api/cron/jobs).
 */
export type JobKind =
  | "ingest_source"
  | "process_email"
  | "notify_handover"
  | "send_staff_reply"
  | "whatsapp_inbound"
  | "outlook_sync"
  | "refresh_web_sources"
  | "retention"
  | "weekly_summary";

export type Job = typeof jobs.$inferSelect;

export const LEASE_MS = 5 * 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number; tx?: DbOrTx } = {},
): Promise<string | null> {
  const runner = opts.tx ?? db;
  const rows = await query<{ id: string }>(
    runner,
    sql`
    INSERT INTO jobs (kind, payload, run_at, dedupe_key, max_attempts)
    VALUES (${kind}, ${JSON.stringify(payload)}::jsonb, ${(opts.runAt ?? new Date()).toISOString()},
            ${opts.dedupeKey ?? null}, ${opts.maxAttempts ?? 5})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
    DO NOTHING
    RETURNING id`,
  );
  return rows[0]?.id ?? null;
}

/** Takes up to `limit` due jobs (queued and due, or running with an expired lease). */
export async function claim(limit: number, now = new Date()): Promise<Job[]> {
  const lease = new Date(now.getTime() + LEASE_MS).toISOString();
  const rows = await query<{ id: string }>(
    db,
    sql`
    UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = ${lease}, updated_at = now()
    WHERE id IN (
      SELECT id FROM jobs
      WHERE (status = 'queued' AND run_at <= ${now.toISOString()})
         OR (status = 'running' AND locked_until < ${now.toISOString()})
      ORDER BY run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`,
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => String(r.id));
  return db.query.jobs.findMany({ where: (j, { inArray }) => inArray(j.id, ids) });
}

export async function complete(id: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "done", lockedUntil: null, finishedAt: new Date(), lastError: null })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")));
}

/** A failure that retrying cannot fix (bad file, missing record): no more attempts. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export async function fail(job: Job, err: unknown, now = new Date()): Promise<"retry" | "failed"> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  const permanent = err instanceof PermanentJobError;
  if (permanent || job.attempts >= job.maxAttempts) {
    await db
      .update(jobs)
      .set({ status: "failed", lockedUntil: null, lastError: message, finishedAt: now })
      .where(eq(jobs.id, job.id));
    return "failed";
  }
  await db
    .update(jobs)
    .set({
      status: "queued",
      lockedUntil: null,
      lastError: message,
      runAt: new Date(now.getTime() + backoffMs(job.attempts)),
    })
    .where(eq(jobs.id, job.id));
  return "retry";
}

export type Handlers = Partial<
  Record<JobKind, (payload: Record<string, unknown>, job: Job) => Promise<void>>
>;

/** Runs due jobs until none are left or the time budget is used. */
export async function runDueJobs(
  handlers: Handlers,
  opts: { budgetMs?: number; batch?: number } = {},
): Promise<{ done: number; retried: number; failed: number }> {
  const deadline = Date.now() + (opts.budgetMs ?? 50_000);
  const result = { done: 0, retried: 0, failed: 0 };
  while (Date.now() < deadline) {
    const batch = await claim(opts.batch ?? 5);
    if (!batch.length) break;
    await Promise.all(
      batch.map(async (job) => {
        const handler = handlers[job.kind as JobKind];
        try {
          if (!handler) throw new PermanentJobError(`No handler for ${job.kind}`);
          await handler(job.payload, job);
          await complete(job.id);
          result.done++;
        } catch (err) {
          console.error(
            `job ${job.kind} ${job.id} failed`,
            err instanceof Error ? err.message : err,
          );
          const outcome = await fail(job, err);
          if (outcome === "retry") result.retried++;
          else result.failed++;
        }
      }),
    );
  }
  return result;
}

/** Old finished jobs are removed by the daily job after 14 days (failed ones after 60). */
export async function pruneJobs(now = new Date()): Promise<number> {
  const rows = await query(
    db,
    sql`
    DELETE FROM jobs
    WHERE (status = 'done' AND finished_at < ${new Date(now.getTime() - 14 * 86_400_000).toISOString()})
       OR (status = 'failed' AND finished_at < ${new Date(now.getTime() - 60 * 86_400_000).toISOString()})
    RETURNING id`,
  );
  return rows.length;
}
