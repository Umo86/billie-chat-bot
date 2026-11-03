import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  bots,
  deadlines,
  exhibitorLists,
  exhibitors,
  reminderBatches,
  reminders,
  type ReminderBatchStatus,
  type ReminderStatus,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { formatDate, londonDate } from "@/lib/time";
import {
  ANY_ANSWER,
  columnValues,
  draftFrom,
  isDone,
  REMIND_DAYS,
  type ColumnValue,
} from "./deadline-rules";

/**
 * Deadline chasers: each exhibitor bot can have deadlines (stand plan,
 * nameboard, electrics), each tied to a column of its exhibitor list. Before
 * a deadline (or when someone asks), Billie drafts one reminder for everyone
 * who hasn't done it, on the job queue. A person checks the email and who
 * it goes to, then sends them all at once; each email is its own job.
 */

export type DeadlineInput = {
  name: string;
  dueOn: string;
  column: string;
  doneValues: string[];
  remindDaysBefore: number;
};

export type BatchSummary = {
  id: string;
  status: ReminderBatchStatus;
  createdAt: string;
  sentAt: string | null;
  count: number;
  sent: number;
  failed: number;
};

export type DeadlineSummary = {
  id: string;
  name: string;
  dueOn: string;
  column: string;
  doneValues: string[];
  remindDaysBefore: number;
  /** On the list and not done yet. */
  notDone: number;
  total: number;
  /** The list was replaced by one without this column. */
  columnMissing: boolean;
  latest: BatchSummary | null;
};

const OPEN: ReminderBatchStatus[] = ["drafting", "ready", "sending"];

function listRows(botId: string) {
  return db
    .select({
      id: exhibitors.id,
      company: exhibitors.company,
      stand: exhibitors.stand,
      name: exhibitors.name,
      emails: exhibitors.emails,
      fields: exhibitors.fields,
    })
    .from(exhibitors)
    .where(eq(exhibitors.botId, botId));
}

/** A bot's deadlines with how many haven't done each, and the list's columns and their answers. */
export async function deadlineSetup(botId: string): Promise<{
  columns: string[];
  values: Record<string, ColumnValue[]>;
  /** How many exhibitors have any answer in each column. */
  filled: Record<string, number>;
  total: number;
  deadlines: DeadlineSummary[];
}> {
  const list = await db.query.exhibitorLists.findFirst({ where: eq(exhibitorLists.botId, botId) });
  const rows = list ? await listRows(botId) : [];
  const columns = list?.columns ?? [];
  const all = await db
    .select()
    .from(deadlines)
    .where(eq(deadlines.botId, botId))
    .orderBy(asc(deadlines.dueOn), asc(deadlines.name));
  const latest = await latestBatches(all.map((d) => d.id));
  return {
    columns,
    values: columnValues(rows, columns, 60),
    filled: Object.fromEntries(
      columns.map((c) => [c, rows.filter((r) => (r.fields[c] ?? "").trim()).length]),
    ),
    total: rows.length,
    deadlines: all.map((d) => ({
      id: d.id,
      name: d.name,
      dueOn: d.dueOn,
      column: d.column,
      doneValues: d.doneValues,
      remindDaysBefore: d.remindDaysBefore,
      notDone: rows.filter((r) => !isDone(r.fields, d.column, d.doneValues)).length,
      total: rows.length,
      columnMissing: Boolean(list) && !columns.includes(d.column),
      latest: latest.get(d.id) ?? null,
    })),
  };
}

async function latestBatches(deadlineIds: string[]): Promise<Map<string, BatchSummary>> {
  const out = new Map<string, BatchSummary>();
  if (!deadlineIds.length) return out;
  const batches = await db
    .select()
    .from(reminderBatches)
    .where(inArray(reminderBatches.deadlineId, deadlineIds))
    .orderBy(desc(reminderBatches.createdAt));
  const newest = batches.filter(
    (b, i) => batches.findIndex((x) => x.deadlineId === b.deadlineId) === i,
  );
  const counts = newest.length
    ? await db
        .select({
          batchId: reminders.batchId,
          status: reminders.status,
          n: sql<number>`count(*)::int`,
        })
        .from(reminders)
        .where(
          inArray(
            reminders.batchId,
            newest.map((b) => b.id),
          ),
        )
        .groupBy(reminders.batchId, reminders.status)
    : [];
  for (const b of newest) {
    const of = (s: ReminderStatus) =>
      counts.find((c) => c.batchId === b.id && c.status === s)?.n ?? 0;
    out.set(b.deadlineId, {
      id: b.id,
      status: b.status,
      createdAt: b.createdAt.toISOString(),
      sentAt: b.sentAt?.toISOString() ?? null,
      count: counts.filter((c) => c.batchId === b.id).reduce((n, c) => n + c.n, 0),
      sent: of("sent"),
      failed: of("failed"),
    });
  }
  return out;
}

function cleanInput(input: DeadlineInput, columns: readonly string[]): DeadlineInput {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60) throw new UserError("Give the deadline a short name.");
  const due = /^\d{4}-\d{2}-\d{2}$/.test(input.dueOn) ? new Date(`${input.dueOn}T12:00:00Z`) : null;
  if (!due || Number.isNaN(due.getTime()) || due.toISOString().slice(0, 10) !== input.dueOn)
    throw new UserError("Pick the date it's due.");
  if (!columns.includes(input.column))
    throw new UserError("Pick the column of the exhibitor list that shows who has done it.");
  const doneValues = [
    ...new Set(
      input.doneValues
        .map((v) => (v === ANY_ANSWER ? v : v.replace(/\s+/g, " ").trim().toLowerCase()))
        .filter(Boolean),
    ),
  ];
  if (!doneValues.length)
    throw new UserError("Tick at least one answer that means they've done it.");
  if (doneValues.length > 50 || doneValues.some((v) => v.length > 120))
    throw new UserError("Tick fewer answers.");
  if (!(REMIND_DAYS as readonly number[]).includes(input.remindDaysBefore))
    throw new UserError("Choose when Billie drafts reminders.");
  return {
    name,
    dueOn: input.dueOn,
    column: input.column,
    doneValues,
    remindDaysBefore: input.remindDaysBefore,
  };
}

/** Adds a deadline (no id) or changes one. */
export async function saveDeadline(
  actor: Actor,
  botId: string,
  input: DeadlineInput,
  id?: string,
): Promise<string> {
  const list = await db.query.exhibitorLists.findFirst({ where: eq(exhibitorLists.botId, botId) });
  if (!list)
    throw new UserError("Upload the exhibitor list first: a deadline uses one of its columns.");
  const d = cleanInput(input, list.columns);
  return db.transaction(async (tx) => {
    let savedId: string;
    if (id) {
      const [row] = await tx
        .update(deadlines)
        .set({ ...d, updatedAt: new Date() })
        .where(and(eq(deadlines.id, id), eq(deadlines.botId, botId)))
        .returning({ id: deadlines.id });
      if (!row) throw new UserError("That deadline no longer exists.");
      savedId = row.id;
    } else {
      const [row] = await tx
        .insert(deadlines)
        .values({ ...d, botId, createdBy: actor.id })
        .returning({ id: deadlines.id });
      savedId = row.id;
    }
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: id ? "update" : "create",
      summary: `${id ? "Changed" : "Added"} the deadline "${d.name}" (due ${formatDate(`${d.dueOn}T12:00:00Z`)})`,
    });
    return savedId;
  });
}

export async function deleteDeadline(actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(deadlines)
      .where(eq(deadlines.id, id))
      .returning({ botId: deadlines.botId, name: deadlines.name });
    if (!gone) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: gone.botId,
      action: "delete",
      summary: `Deleted the deadline "${gone.name}" and its reminders`,
    });
  });
}

/**
 * Starts a batch for everyone who hasn't done it, and queues Billie writing
 * the email. Someone asking gets a plain reason when there's nothing to
 * start; the schedule (no actor) just skips.
 */
export async function startReminders(
  actor: Actor | null,
  deadlineId: string,
): Promise<{ batchId: string; count: number } | null> {
  const refuse = (why: string) => {
    if (actor) throw new UserError(why);
    return null;
  };
  const started = await db.transaction(async (tx) => {
    // Locked: two clicks, or a click and the schedule, can't both start one.
    const [d] = await tx.select().from(deadlines).where(eq(deadlines.id, deadlineId)).for("update");
    if (!d) return refuse("That deadline no longer exists.");
    const [open] = await tx
      .select({ id: reminderBatches.id })
      .from(reminderBatches)
      .where(and(eq(reminderBatches.deadlineId, d.id), inArray(reminderBatches.status, OPEN)))
      .limit(1);
    if (open) return refuse("Reminders for this deadline are already waiting. Check those first.");
    const list = await tx.query.exhibitorLists.findFirst({
      where: eq(exhibitorLists.botId, d.botId),
    });
    if (!list) return refuse("Upload the exhibitor list first.");
    // Without its column everyone would look not done: never chase them all.
    if (!list.columns.includes(d.column))
      return refuse(
        `The exhibitor list has no "${d.column}" column any more. Edit the deadline first.`,
      );
    const rows = await tx
      .select()
      .from(exhibitors)
      .where(eq(exhibitors.botId, d.botId))
      .orderBy(asc(exhibitors.company), asc(exhibitors.stand));
    const due = rows.filter((r) => !isDone(r.fields, d.column, d.doneValues));
    if (!due.length) return refuse("Everyone on the list has done this. There's nobody to remind.");
    const [batch] = await tx
      .insert(reminderBatches)
      .values({ deadlineId: d.id, botId: d.botId, requestedBy: actor?.id ?? null })
      .returning({ id: reminderBatches.id });
    for (let i = 0; i < due.length; i += 500)
      await tx.insert(reminders).values(
        due.slice(i, i + 500).map((r) => ({
          batchId: batch.id,
          exhibitorId: r.id,
          company: r.company,
          stand: r.stand,
          name: r.name,
          to: r.emails,
        })),
      );
    await writeAudit(tx, {
      actorUserId: actor?.id ?? null,
      actorType: actor ? "user" : "system",
      entityType: "bot",
      entityId: d.botId,
      action: "create",
      summary: `${actor ? "Asked Billie to draft" : "Billie started drafting"} ${due.length} ${due.length === 1 ? "reminder" : "reminders"} for "${d.name}"`,
    });
    await enqueue(
      "draft_reminders",
      { batchId: batch.id },
      { tx, dedupeKey: `reminders:${batch.id}`, once: true, maxAttempts: 2 },
    );
    return { batchId: batch.id, count: due.length };
  });
  if (started) await kickJobs();
  return started;
}

/**
 * The daily schedule: deadlines whose reminder day has come (and that are
 * still to come) get a batch, once per deadline and reminder day.
 */
export async function startScheduledReminders(now = new Date()): Promise<number> {
  const today = londonDate(now);
  const due = await db
    .select({ id: deadlines.id, dueOn: deadlines.dueOn, remind: deadlines.remindDaysBefore })
    .from(deadlines)
    .innerJoin(bots, eq(bots.id, deadlines.botId))
    .where(
      and(
        sql`${bots.deletedAt} IS NULL`,
        sql`${deadlines.remindDaysBefore} > 0`,
        sql`${deadlines.dueOn} >= ${today}::date`,
      ),
    );
  let started = 0;
  for (const d of due) {
    const from = draftFrom(d.dueOn, d.remind);
    if (!from || today < from) continue;
    // Once per reminder day: a batch started since then (by hand or on schedule) counts.
    const [already] = await db
      .select({ id: reminderBatches.id })
      .from(reminderBatches)
      .where(
        and(
          eq(reminderBatches.deadlineId, d.id),
          sql`(${reminderBatches.createdAt} AT TIME ZONE 'Europe/London')::date >= ${from}::date`,
        ),
      )
      .limit(1);
    if (already) continue;
    if (await startReminders(null, d.id)) started++;
  }
  return started;
}
