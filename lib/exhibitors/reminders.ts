import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/lib/db/client";
import {
  botMailboxes,
  bots,
  deadlines,
  exhibitorLists,
  exhibitors,
  reminderBatches,
  reminders,
  users,
  type ReminderBatchStatus,
  type ReminderStatus,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";
import { appUrl, emailConfigured } from "@/lib/config";
import { enqueue, PermanentJobError } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { AiError, structured } from "@/lib/ai/provider";
import { fallbackFor, modelFor } from "@/lib/ai/models";
import { knowledgeBlock, reminderSystem, reminderUser } from "@/lib/ai/prompts";
import { reminderJsonSchema, reminderSchema } from "@/lib/ai/schemas";
import { capReached, recordUsage } from "@/lib/ai/usage";
import { citeSources } from "@/lib/ai/answer";
import { answerBotFor, botById } from "@/lib/bots/load";
import { retrieve } from "@/lib/knowledge/search";
import { getSettings } from "@/lib/settings";
import { sendEmail, textToHtml } from "@/lib/email/send";
import { adaptiveMessage, plainLine } from "@/lib/alerts/card";
import { cardOf, queueDirect } from "@/lib/alerts/direct";
import { worksOnBotSql } from "@/lib/auth/bots";
import { fillIn, isDone, unknownPlaceholders } from "./deadline-rules";

/**
 * Deadline reminders after a batch is started (lib/exhibitors/deadlines.ts):
 * Billie writes the email (a job), the person who asked hears in Teams, a
 * person checks it and sends, and one job sends them one by one, gently, so
 * the email service's rate limit is never hit.
 */

const longDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** "Friday 14 February 2027" (built from parts: some ICU versions add a comma). */
export function dueLabel(dueOn: string): string {
  const p = Object.fromEntries(
    longDate.formatToParts(new Date(`${dueOn}T12:00:00Z`)).map((x) => [x.type, x.value]),
  );
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

async function setBatch(id: string, values: Partial<typeof reminderBatches.$inferInsert>) {
  await db.update(reminderBatches).set(values).where(eq(reminderBatches.id, id));
}

/** The "draft_reminders" job: Billie writes the one email everyone gets. */
export async function writeReminders(
  batchId: string,
  opts: { lastTry?: boolean } = {},
): Promise<void> {
  const batch = await db.query.reminderBatches.findFirst({
    where: eq(reminderBatches.id, batchId),
  });
  if (!batch || batch.status !== "drafting") return;
  const failed = (note: string) => setBatch(batchId, { status: "failed", note });
  const [d, bot] = await Promise.all([
    db.query.deadlines.findFirst({ where: eq(deadlines.id, batch.deadlineId) }),
    botById(batch.botId),
  ]);
  if (!d || !bot) return void (await failed("The bot or the deadline was deleted."));
  try {
    if (await capReached("staff"))
      return void (await failed(
        "Today's answer limit has been reached. Draft them again tomorrow, or raise the limit in Settings.",
      ));
    const due = dueLabel(d.dueOn);
    const passages = await retrieve(
      (await answerBotFor(bot)).knowledgeBaseIds,
      `${d.name} deadline ${d.column}`.slice(0, 400),
    );
    const result = await structured({
      purpose: "deadline_reminder",
      model: modelFor("thorough"),
      fallbackModel: fallbackFor("thorough"),
      system: reminderSystem({ show: bot.showName, tone: bot.tone, personality: bot.personality }),
      knowledge: knowledgeBlock(passages),
      user: reminderUser({ deadline: d.name, due, column: d.column }),
      schema: reminderJsonSchema,
      maxTokens: 1200,
      fake: { purpose: "deadline_reminder", deadline: d.name, due, passages },
    });
    await recordUsage("reminders", result.usage);
    const r = reminderSchema.parse(result.json);
    // The sign-off is added here, word for word, as with email drafts.
    const settings = await getSettings();
    const signature = (bot.emailSignOff.trim() || settings.emailSignature).trim();
    await setBatch(batchId, {
      status: "ready",
      subject: r.subject.replace(/\s+/g, " ").trim().slice(0, 200),
      body: `${r.body.trim()}\n\n${signature}`.trim().slice(0, 10_000),
      note: r.missing.trim().slice(0, 300),
      sources: citeSources(r.used, passages).map((s) => ({ title: s.title, label: s.label })),
    });
    await tellReady(batchId);
  } catch (err) {
    if (err instanceof AiError && err.code === "not_configured")
      return void (await failed("Claude isn't connected yet."));
    if (opts.lastTry || err instanceof PermanentJobError)
      return void (await failed("Billie couldn't write the reminder. Draft them again."));
    throw err; // tried again
  }
}

/** A Teams message to whoever asked (or set the deadline up), else the bot's editors. */
async function tellReady(batchId: string): Promise<void> {
  const [row] = await db
    .select({
      botId: reminderBatches.botId,
      botName: bots.name,
      deadline: deadlines.name,
      dueOn: deadlines.dueOn,
      requestedBy: reminderBatches.requestedBy,
      createdBy: deadlines.createdBy,
    })
    .from(reminderBatches)
    .innerJoin(deadlines, eq(deadlines.id, reminderBatches.deadlineId))
    .innerJoin(bots, eq(bots.id, reminderBatches.botId))
    .where(eq(reminderBatches.id, batchId));
  if (!row) return;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reminders)
    .where(eq(reminders.batchId, batchId));
  const who = row.requestedBy ?? row.createdBy;
  let people = who
    ? await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.id, who), eq(users.status, "active"), worksOnBotSql(row.botId)))
    : [];
  if (!people.length)
    people = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, "editor"), eq(users.status, "active"), worksOnBotSql(row.botId)));
  const card = adaptiveMessage({
    body: [
      plainLine(`${n} ${n === 1 ? "reminder" : "reminders"} for ${row.deadline} to check`, {
        bold: true,
        size: "Medium",
      }),
      plainLine(`${row.botName} · due ${dueLabel(row.dueOn)}`, { spacing: "None" }),
      plainLine("Billie wrote the email. Check it and who it goes to, then send them all at once."),
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "Check and send",
        url: `${appUrl()}/bots/${row.botId}/reminders/${batchId}`,
      },
    ],
  });
  await queueDirect(people, `reminders-ready:${batchId}`, cardOf(card));
}

export type Recipient = {
  id: string;
  company: string;
  stand: string;
  name: string;
  to: string[];
  status: ReminderStatus;
  note: string;
  /** Since it was drafted: done now, or gone from the list (only while it's waiting). */
  since: "done" | "gone" | null;
};

/** Who's in the batch, and which of them have done it (or left the list) since. */
async function recipientsOf(
  runner: DbOrTx,
  batch: { id: string; botId: string; status: ReminderBatchStatus },
  d: { column: string; doneValues: string[] },
): Promise<Recipient[]> {
  const rows = await runner
    .select()
    .from(reminders)
    .where(eq(reminders.batchId, batch.id))
    .orderBy(asc(reminders.company), asc(reminders.stand), asc(reminders.id));
  const waiting = batch.status === "drafting" || batch.status === "ready";
  const list = waiting
    ? await runner.query.exhibitorLists.findFirst({ where: eq(exhibitorLists.botId, batch.botId) })
    : null;
  const current = list
    ? await runner
        .select({ emails: exhibitors.emails, fields: exhibitors.fields })
        .from(exhibitors)
        .where(eq(exhibitors.botId, batch.botId))
    : [];
  const byEmail = new Map<string, Record<string, string>>();
  for (const c of current) for (const e of c.emails) byEmail.set(e, c.fields);
  const hasColumn = Boolean(list?.columns.includes(d.column));
  return rows.map((r) => {
    let since: Recipient["since"] = null;
    if (waiting && r.status === "pending") {
      const now = r.to.map((e) => byEmail.get(e)).find(Boolean);
      if (!now) since = "gone";
      else if (hasColumn && isDone(now, d.column, d.doneValues)) since = "done";
    }
    return {
      id: r.id,
      company: r.company,
      stand: r.stand,
      name: r.name,
      to: r.to,
      status: r.status,
      note: r.note,
      since,
    };
  });
}

/** Everything the review page shows. */
export async function batchDetail(batchId: string) {
  const [row] = await db
    .select({ batch: reminderBatches, deadline: deadlines, botName: bots.name })
    .from(reminderBatches)
    .innerJoin(deadlines, eq(deadlines.id, reminderBatches.deadlineId))
    .innerJoin(bots, eq(bots.id, reminderBatches.botId))
    .where(eq(reminderBatches.id, batchId));
  if (!row) return null;
  const [recipients, replyTo, by] = await Promise.all([
    recipientsOf(db, row.batch, row.deadline),
    replyAddress(row.batch.botId),
    row.batch.sentBy
      ? db.query.users.findFirst({
          where: eq(users.id, row.batch.sentBy),
          columns: { fullName: true },
        })
      : null,
  ]);
  return {
    batch: { ...row.batch, sentByName: by?.fullName ?? null },
    deadline: row.deadline,
    botName: row.botName,
    recipients,
    replyTo,
    emailReady: emailConfigured(),
  };
}

/** Replies go to the event's mailbox, where Billie drafts answers to them. */
async function replyAddress(botId: string): Promise<string | null> {
  const m = await db.query.botMailboxes.findFirst({
    where: and(eq(botMailboxes.botId, botId), eq(botMailboxes.enabled, true)),
    columns: { address: true },
  });
  return m?.address ?? null;
}

function cleanText(input: { subject: string; body: string }) {
  const subject = input.subject.replace(/\s+/g, " ").trim();
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (!subject) throw new UserError("Write a subject line.");
  if (subject.length > 200) throw new UserError("Keep the subject under 200 characters.");
  if (body.length < 20) throw new UserError("Write the email first.");
  if (body.length > 10_000) throw new UserError("Keep the email under 10,000 characters.");
  const unknown = unknownPlaceholders(`${subject}\n${body}`);
  if (unknown.length)
    throw new UserError(
      `Billie can't fill in ${unknown.join(", ")}. Use {first_name}, {company} or {stand}, or take it out.`,
    );
  return { subject, body };
}

async function lockedBatch(tx: DbOrTx, batchId: string) {
  const [b] = await tx
    .select()
    .from(reminderBatches)
    .where(eq(reminderBatches.id, batchId))
    .for("update");
  if (!b) throw new UserError("Those reminders no longer exist.");
  if (b.status === "sending" || b.status === "sent")
    throw new UserError("These reminders have already been sent.");
  if (b.status === "discarded") throw new UserError("These reminders were discarded.");
  if (b.status !== "ready") throw new UserError("Billie hasn't finished writing these yet.");
  return b;
}

/** Saves the person's changes to the email without sending. */
export async function saveReminderText(
  actor: Actor,
  batchId: string,
  input: { subject: string; body: string },
): Promise<void> {
  const text = cleanText(input);
  await db.transaction(async (tx) => {
    const b = await lockedBatch(tx, batchId);
    await tx.update(reminderBatches).set(text).where(eq(reminderBatches.id, b.id));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: b.botId,
      action: "update",
      summary: "Changed the wording of deadline reminders",
    });
  });
}

/**
 * Sends the batch: everyone ticked who still hasn't done it gets the email.
 * Those left out, done since or gone from the list are marked and skipped.
 */
export async function sendReminders(
  actor: Actor,
  batchId: string,
  input: { subject: string; body: string; leaveOut: string[] },
): Promise<{ queued: number; leftOut: number }> {
  if (!emailConfigured())
    throw new UserError(
      "Email sending isn't set up, so nothing can be sent yet. An admin adds RESEND_API_KEY and EMAIL_FROM.",
    );
  const text = cleanText(input);
  const leave = new Set(input.leaveOut);
  const result = await db.transaction(async (tx) => {
    const b = await lockedBatch(tx, batchId);
    const d = await tx.query.deadlines.findFirst({ where: eq(deadlines.id, b.deadlineId) });
    if (!d) throw new UserError("That deadline no longer exists.");
    const people = await recipientsOf(tx, b, d);
    const waiting = people.filter((p) => p.status === "pending");
    const why = (p: Recipient) =>
      leave.has(p.id)
        ? "Left out"
        : p.since === "done"
          ? "Done since this was drafted"
          : p.since === "gone"
            ? "Not on the exhibitor list any more"
            : null;
    const send = waiting.filter((p) => !why(p));
    const skip = waiting.filter((p) => why(p));
    if (!send.length) throw new UserError("Nobody is ticked, so there's nothing to send.");
    for (const note of new Set(skip.map((p) => why(p)!)))
      await tx
        .update(reminders)
        .set({ status: "left_out", note })
        .where(
          inArray(
            reminders.id,
            skip.filter((p) => why(p) === note).map((p) => p.id),
          ),
        );
    for (let i = 0; i < send.length; i += 1000)
      await tx
        .update(reminders)
        .set({ status: "queued" })
        .where(
          inArray(
            reminders.id,
            send.slice(i, i + 1000).map((p) => p.id),
          ),
        );
    await tx
      .update(reminderBatches)
      .set({ ...text, status: "sending", sentBy: actor.id, sentAt: new Date() })
      .where(eq(reminderBatches.id, b.id));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: b.botId,
      action: "create",
      summary: `Sent ${send.length} ${send.length === 1 ? "reminder" : "reminders"} for "${d.name}"${skip.length ? ` (${skip.length} left out)` : ""}`,
    });
    await enqueue(
      "send_reminders",
      { batchId: b.id, round: 1 },
      { tx, dedupeKey: `send-reminders:${b.id}:1`, once: true, maxAttempts: 3 },
    );
    return { queued: send.length, leftOut: skip.length };
  });
  // A round of sending takes up to 40 seconds: only where there's time (a long job).
  await kickJobs({ long: true });
  return result;
}

/** Throws the batch away (before it's sent). */
export async function discardReminders(actor: Actor, batchId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [b] = await tx
      .select()
      .from(reminderBatches)
      .where(eq(reminderBatches.id, batchId))
      .for("update");
    if (!b) return;
    if (b.status === "sending" || b.status === "sent")
      throw new UserError("These reminders have already been sent.");
    if (b.status === "discarded") return;
    await tx
      .update(reminderBatches)
      .set({ status: "discarded" })
      .where(eq(reminderBatches.id, b.id));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: b.botId,
      action: "delete",
      summary: "Discarded deadline reminders without sending them",
    });
  });
}

/** Queues the ones that failed to send for another go. */
export async function retryFailedReminders(actor: Actor, batchId: string): Promise<number> {
  if (!emailConfigured()) throw new UserError("Email sending isn't set up.");
  const n = await db.transaction(async (tx) => {
    const [b] = await tx
      .select()
      .from(reminderBatches)
      .where(eq(reminderBatches.id, batchId))
      .for("update");
    if (!b || (b.status !== "sent" && b.status !== "sending")) return 0;
    const again = await tx
      .update(reminders)
      .set({ status: "queued", note: "" })
      .where(and(eq(reminders.batchId, b.id), eq(reminders.status, "failed")))
      .returning({ id: reminders.id });
    if (!again.length) return 0;
    await tx.update(reminderBatches).set({ status: "sending" }).where(eq(reminderBatches.id, b.id));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: b.botId,
      action: "update",
      summary: `Tried ${again.length} deadline ${again.length === 1 ? "reminder" : "reminders"} again`,
    });
    const round = Date.now();
    await enqueue(
      "send_reminders",
      { batchId: b.id, round },
      { tx, dedupeKey: `send-reminders:${b.id}:${round}`, once: true, maxAttempts: 3 },
    );
    return again.length;
  });
  if (n) await kickJobs({ long: true });
  return n;
}

/**
 * The "send_reminders" job: sends the queued reminders one at a time, with
 * a pause between them, for up to `budgetMs`; then queues itself again for
 * the rest. Each is marked sent (or failed, with why) as it goes, so a retry
 * never sends one twice.
 */
export async function sendReminderBatch(
  batchId: string,
  opts: { round: number; budgetMs?: number; pauseMs?: number },
): Promise<{ sent: number; failed: number; left: number }> {
  const until = Date.now() + (opts.budgetMs ?? 40_000);
  const pause = opts.pauseMs ?? 400;
  const out = { sent: 0, failed: 0, left: 0 };
  const batch = await db.query.reminderBatches.findFirst({
    where: eq(reminderBatches.id, batchId),
  });
  if (!batch || batch.status !== "sending") return out;
  const replyTo = await replyAddress(batch.botId);

  while (Date.now() < until) {
    const next = await db
      .select()
      .from(reminders)
      .where(and(eq(reminders.batchId, batchId), eq(reminders.status, "queued")))
      .orderBy(asc(reminders.company), asc(reminders.id))
      .limit(10);
    if (!next.length) break;
    for (const r of next) {
      if (Date.now() >= until) break;
      const who = { name: r.name, company: r.company, stand: r.stand };
      const text = fillIn(batch.body, who);
      try {
        await sendEmail({
          to: r.to,
          subject: fillIn(batch.subject, who),
          text,
          html: textToHtml(text),
          ...(replyTo ? { replyTo } : {}),
        });
        await db
          .update(reminders)
          .set({ status: "sent", sentAt: new Date(), note: "" })
          .where(and(eq(reminders.id, r.id), eq(reminders.status, "queued")));
        out.sent++;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        await db
          .update(reminders)
          .set({ status: "failed", note: `Not sent: ${why}`.slice(0, 300) })
          .where(and(eq(reminders.id, r.id), eq(reminders.status, "queued")));
        out.failed++;
      }
      if (pause) await new Promise((res) => setTimeout(res, pause));
    }
  }

  const [{ left }] = await db
    .select({ left: sql<number>`count(*)::int` })
    .from(reminders)
    .where(and(eq(reminders.batchId, batchId), eq(reminders.status, "queued")));
  out.left = left;
  if (left) {
    const round = opts.round + 1;
    await enqueue(
      "send_reminders",
      { batchId, round },
      { dedupeKey: `send-reminders:${batchId}:${round}`, once: true, maxAttempts: 3 },
    );
  } else {
    await db
      .update(reminderBatches)
      .set({ status: "sent" })
      .where(and(eq(reminderBatches.id, batchId), eq(reminderBatches.status, "sending")));
  }
  return out;
}

/** Batches waiting for a person to check, for Home. */
export async function remindersToCheck(botIds: string[] | null) {
  if (botIds && !botIds.length) return [];
  return db
    .select({
      id: reminderBatches.id,
      botId: reminderBatches.botId,
      botName: bots.name,
      deadline: deadlines.name,
      count: sql<number>`(SELECT count(*)::int FROM ${reminders} r WHERE r.batch_id = ${reminderBatches.id})`,
    })
    .from(reminderBatches)
    .innerJoin(deadlines, eq(deadlines.id, reminderBatches.deadlineId))
    .innerJoin(bots, eq(bots.id, reminderBatches.botId))
    .where(
      and(
        eq(reminderBatches.status, "ready"),
        sql`${bots.deletedAt} IS NULL`,
        botIds ? inArray(reminderBatches.botId, botIds) : undefined,
      ),
    )
    .orderBy(asc(deadlines.dueOn))
    .limit(10);
}
