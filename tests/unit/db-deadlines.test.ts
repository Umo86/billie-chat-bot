import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  auditLog,
  bots,
  conversations,
  deadlines,
  exhibitors,
  jobs,
  reminderBatches,
  reminders,
} from "@/lib/db/schema";
import { uploadList } from "@/lib/exhibitors/service";
import {
  deadlineSetup,
  reminderPlan,
  saveDeadline,
  saveReminderPlan,
  startReminders,
  startScheduledReminders,
  type DeadlineInput,
} from "@/lib/exhibitors/deadlines";
import { DEFAULT_PLAN } from "@/lib/exhibitors/reminder-plan";
import { botById } from "@/lib/bots/load";
import { startConversation, visitorUpdates } from "@/lib/conversations/service";
import { exhibitorChecklist, taskExhibitor } from "@/lib/requests/tasks";
import {
  batchDetail,
  discardReminders,
  remindersToCheck,
  retryFailedReminders,
  saveReminderText,
  sendReminderBatch,
  sendReminders,
  writeReminders,
} from "@/lib/exhibitors/reminders";
import { saveMailbox } from "@/lib/emails/mailboxes";
import { deletePerson, findPerson } from "@/lib/privacy/requests";
import { runRetention } from "@/lib/privacy/retention";
import { londonDate } from "@/lib/time";
import { hasDb, makeBot, makeUser } from "../helpers/db";

type Sent = {
  to: string[];
  subject: string;
  text: string;
  replyTo?: string;
  idempotencyKey?: string;
};
const sent = vi.hoisted(() => [] as Sent[]);
vi.mock("@/lib/email/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/send")>()),
  sendEmail: async (e: Sent) => {
    if (e.to.some((t) => t.startsWith("bounce@"))) throw new Error("Email not sent: rejected");
    sent.push(e);
  },
}));

function csv(rows: string[][]): Buffer {
  return Buffer.from(
    rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n"),
  );
}

/** A list of four exhibitors; two have their stand plan approved. Addresses are this test's own. */
function makeList(plan: Record<string, string> = {}) {
  const d = randomUUID().slice(0, 8);
  const e = {
    acme: `sam@acme-${d}.test`,
    bolt: `jo@bolt-${d}.test`,
    kite: `kim@kite-${d}.test`,
    oak: `lee@oak-${d}.test`,
  };
  const rows = [
    ["Company", "Stand", "Contact", "Email", "Stand plan approved", "Nameboard"],
    ["Acme Ltd", "B12", "Sam Patel", e.acme, plan.acme ?? "No", "12/01/2027"],
    ["Bolt & Co", "C4", "Jo Bloggs", e.bolt, plan.bolt ?? "Yes", ""],
    ["Kite Stands", "D7", "Kim Lee", e.kite, plan.kite ?? "", "14/01/2027"],
    ["Oak Builds", "A1", "Lee Grant", e.oak, plan.oak ?? "Approved", ""],
  ];
  return { e, rows };
}

const PLAN: DeadlineInput = {
  name: "Stand plan",
  dueOn: "2027-02-14",
  column: "Stand plan approved",
  doneValues: ["yes", "approved"],
  remindDaysBefore: 7,
};

async function setup() {
  const admin = await makeUser("admin");
  const { bot } = await makeBot();
  const list = makeList();
  await uploadList(admin, bot.id, { name: "list.csv", bytes: csv(list.rows) });
  return { admin, bot, ...list };
}

describe.skipIf(!hasDb)("deadlines", () => {
  it("are tied to a column of the list, with answers that mean done", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    await expect(saveDeadline(admin, bot.id, PLAN)).rejects.toThrow(/Upload the exhibitor list/);
    const { rows } = makeList();
    await uploadList(admin, bot.id, { name: "list.csv", bytes: csv(rows) });
    await expect(saveDeadline(admin, bot.id, { ...PLAN, column: "Electrics" })).rejects.toThrow(
      /Pick the column/,
    );
    await expect(saveDeadline(admin, bot.id, { ...PLAN, doneValues: [] })).rejects.toThrow(
      /Tick at least one/,
    );
    await expect(saveDeadline(admin, bot.id, { ...PLAN, dueOn: "2027-02-30" })).rejects.toThrow(
      /Pick the date/,
    );
    await expect(saveDeadline(admin, bot.id, { ...PLAN, remindDaysBefore: 5 })).rejects.toThrow(
      /Choose when/,
    );

    const id = await saveDeadline(admin, bot.id, { ...PLAN, doneValues: [" YES ", "approved"] });
    await saveDeadline(admin, bot.id, {
      name: "Nameboard",
      dueOn: "2027-01-20",
      column: "Nameboard",
      doneValues: ["*any"],
      remindDaysBefore: 0,
    });
    const s = await deadlineSetup(bot.id);
    expect(s.columns).toEqual(["Stand plan approved", "Nameboard"]);
    expect(s.total).toBe(4);
    expect(s.filled).toEqual({ "Stand plan approved": 3, Nameboard: 2 });
    // Soonest first.
    expect(s.deadlines.map((d) => [d.name, d.notDone])).toEqual([
      ["Nameboard", 2],
      ["Stand plan", 2],
    ]);
    expect(s.deadlines[1]).toMatchObject({ id, doneValues: ["yes", "approved"], latest: null });

    // A list without the column: the deadline says so, and nobody gets chased.
    await uploadList(admin, bot.id, {
      name: "new.csv",
      bytes: csv(rows.map((r) => [r[0], r[1], r[2], r[3], r[5]])),
    });
    const after = await deadlineSetup(bot.id);
    expect(after.deadlines.find((d) => d.id === id)?.columnMissing).toBe(true);
    await expect(startReminders(admin, id)).rejects.toThrow(/no "Stand plan approved" column/);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, bot.id));
    expect(audit.map((a) => a.summary)).toContain(
      'Added the deadline "Stand plan" (due 14 Feb 2027)',
    );
  });
});

describe.skipIf(!hasDb)("deadline reminders", () => {
  beforeAll(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test_not_real");
    vi.stubEnv("EMAIL_FROM", "Billie <billie@media10.test>");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    sent.length = 0;
  });

  it("drafts one email for everyone who hasn't done it, once at a time", async () => {
    const { admin, bot, e } = await setup();
    const id = await saveDeadline(admin, bot.id, PLAN);
    const started = await startReminders(admin, id);
    expect(started?.count).toBe(2); // Acme said No, Kite has no answer
    await expect(startReminders(admin, id)).rejects.toThrow(/already waiting/);
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, `reminders:${started!.batchId}`));
    expect(job?.kind).toBe("draft_reminders");

    await writeReminders(started!.batchId);
    const detail = (await batchDetail(started!.batchId))!;
    expect(detail.batch.status).toBe("ready");
    expect(detail.batch.subject).toBe("Reminder: Stand plan by Sunday 14 February 2027");
    expect(detail.batch.body).toMatch(/^Hi \{first_name\},/);
    expect(detail.batch.body).toContain("{company} ({stand})");
    // The bot has no knowledge: Billie says what's missing.
    expect(detail.batch.note).toMatch(/How and where/);
    expect(detail.recipients.map((r) => [r.company, r.to, r.since])).toEqual([
      ["Acme Ltd", [e.acme], null],
      ["Kite Stands", [e.kite], null],
    ]);
    expect(await remindersToCheck([bot.id])).toEqual([
      expect.objectContaining({ id: started!.batchId, deadline: "Stand plan", count: 2 }),
    ]);
  });

  it("sends to those ticked who still haven't done it, filled in for each", async () => {
    const { admin, bot, e, rows } = await setup();
    await saveMailbox(admin, bot.id, {
      address: `ukcw-${randomUUID().slice(0, 6)}@media-ten.test`,
      assignedUserId: null,
      enabled: true,
    });
    const id = await saveDeadline(admin, bot.id, { ...PLAN, doneValues: ["yes"] });
    const { batchId } = (await startReminders(admin, id))!;
    expect((await batchDetail(batchId))!.recipients).toHaveLength(3); // Acme, Kite, Oak
    await writeReminders(batchId);

    // Since drafting, Kite's plan was approved: they're left out.
    const changed = rows.map((r) => (r[0] === "Kite Stands" ? [...r.slice(0, 4), "Yes", r[5]] : r));
    await uploadList(admin, bot.id, { name: "list.csv", bytes: csv(changed) });
    const detail = (await batchDetail(batchId))!;
    expect(detail.recipients.map((r) => [r.company, r.since])).toEqual([
      ["Acme Ltd", null],
      ["Kite Stands", "done"],
      ["Oak Builds", null],
    ]);
    const oak = detail.recipients.find((r) => r.company === "Oak Builds")!;

    await expect(
      sendReminders(admin, batchId, {
        subject: detail.batch.subject,
        body: "Hi {name}, please send it.",
        leaveOut: [],
      }),
    ).rejects.toThrow(/can't fill in \{name\}/);
    const result = await sendReminders(admin, batchId, {
      subject: "Your stand plan for {stand}",
      body: "Hi {first_name},\n\nPlease send the stand plan for {company} by Sunday.",
      leaveOut: [oak.id],
    });
    expect(result).toEqual({ queued: 1, leftOut: 2 });
    await expect(
      sendReminders(admin, batchId, {
        subject: "x",
        body: "Hi {first_name}, send it.",
        leaveOut: [],
      }),
    ).rejects.toThrow(/already been sent/);

    const done = await sendReminderBatch(batchId, { round: 1, pauseMs: 0 });
    expect(done).toEqual({ sent: 1, failed: 0, left: 0 });
    expect(sent).toEqual([
      expect.objectContaining({
        to: [e.acme],
        subject: "Your stand plan for stand B12",
        text: "Hi Sam,\n\nPlease send the stand plan for Acme Ltd by Sunday.",
        replyTo: detail.replyTo,
      }),
    ]);
    const after = (await batchDetail(batchId))!;
    expect(after.batch.status).toBe("sent");
    expect(after.recipients.map((r) => [r.company, r.status, r.note])).toEqual([
      ["Acme Ltd", "sent", ""],
      ["Kite Stands", "left_out", "Done since this was drafted"],
      ["Oak Builds", "left_out", "Left out"],
    ]);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, bot.id));
    expect(audit.map((a) => a.summary)).toContain('Sent 1 reminder for "Stand plan" (2 left out)');
  });

  it("keeps going in rounds, and can try the ones that failed again", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const d = randomUUID().slice(0, 8);
    await uploadList(admin, bot.id, {
      name: "list.csv",
      bytes: csv([
        ["Company", "Email", "Plan"],
        ["Acme", `a@acme-${d}.test`, "No"],
        ["Bounce", `bounce@bad-${d}.test`, "No"],
        ["Kite", `k@kite-${d}.test`, ""],
      ]),
    });
    const id = await saveDeadline(admin, bot.id, { ...PLAN, column: "Plan" });
    const { batchId } = (await startReminders(admin, id))!;
    await writeReminders(batchId);
    await saveReminderText(admin, batchId, {
      subject: "Stand plan",
      body: "Hi {first_name}, please send your stand plan.",
    });
    await sendReminders(admin, batchId, {
      subject: "Stand plan",
      body: "Hi {first_name}, please send your stand plan.",
      leaveOut: [],
    });

    // Out of time straight away: nothing sent, the next round is queued.
    expect(await sendReminderBatch(batchId, { round: 1, budgetMs: 0 })).toEqual({
      sent: 0,
      failed: 0,
      left: 3,
    });
    const next = await db
      .select()
      .from(jobs)
      .where(like(jobs.dedupeKey, `send-reminders:${batchId}:2`));
    expect(next).toHaveLength(1);

    expect(await sendReminderBatch(batchId, { round: 2, pauseMs: 0 })).toEqual({
      sent: 2,
      failed: 1,
      left: 0,
    });
    let detail = (await batchDetail(batchId))!;
    expect(detail.batch.status).toBe("sent");
    expect(detail.recipients.find((r) => r.company === "Bounce")).toMatchObject({
      status: "failed",
      note: "Not sent: Email not sent: rejected",
    });

    expect(await retryFailedReminders(admin, batchId)).toBe(1);
    expect((await batchDetail(batchId))!.batch.status).toBe("sending");
    await sendReminderBatch(batchId, { round: 3, pauseMs: 0 });
    detail = (await batchDetail(batchId))!;
    expect(detail.batch.status).toBe("sent");
    expect(sent.map((s) => s.to[0]).sort()).toEqual([`a@acme-${d}.test`, `k@kite-${d}.test`]);
  });

  it("never sends one twice: two jobs at once, a retry only after the round, a key for each", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const d = randomUUID().slice(0, 8);
    const rows = [
      ["Company", "Email", "Plan"],
      ["Acme", `a@acme-${d}.test`, "No"],
      ["Bounce", `bounce@bad-${d}.test`, "No"],
      ["Kite", `k@kite-${d}.test`, ""],
      ["Oak", `o@oak-${d}.test`, ""],
    ];
    await uploadList(admin, bot.id, { name: "list.csv", bytes: csv(rows) });
    const id = await saveDeadline(admin, bot.id, { ...PLAN, column: "Plan" });
    const { batchId } = (await startReminders(admin, id))!;
    await writeReminders(batchId);
    const text = { subject: "Stand plan", body: "Hi {first_name}, please send your stand plan." };
    await saveReminderText(admin, batchId, text);
    await sendReminders(admin, batchId, { ...text, leaveOut: [] });
    // Since it was drafted, Oak came off the list: they aren't sent it.
    await uploadList(admin, bot.id, { name: "list.csv", bytes: csv(rows.slice(0, 4)) });

    sent.length = 0;
    // Two jobs at once (a retry overlapping a slow one): each reminder goes once.
    await Promise.all([
      sendReminderBatch(batchId, { round: 1, pauseMs: 5 }),
      sendReminderBatch(batchId, { round: 1, pauseMs: 5 }),
    ]);
    expect(sent.map((s) => s.to[0]).sort()).toEqual([`a@acme-${d}.test`, `k@kite-${d}.test`]);
    const detail = (await batchDetail(batchId))!;
    expect(detail.recipients.find((r) => r.company === "Oak")).toMatchObject({
      status: "left_out",
      note: "Left out: no longer on the exhibitor list.",
    });
    const acme = detail.recipients.find((r) => r.company === "Acme")!;
    expect(sent.find((s) => s.to[0].startsWith("a@"))?.idempotencyKey).toBe(
      `deadline-reminder/${acme.id}/0`,
    );

    // One that a job claimed and then died on is picked up again, with the same key.
    const bounce = detail.recipients.find((r) => r.company === "Bounce")!;
    expect(bounce.status).toBe("failed");
    expect(await retryFailedReminders(admin, batchId)).toBe(1);
    // While that round is still sending, trying again is refused.
    expect(await retryFailedReminders(admin, batchId)).toBe(0);
    await db
      .update(reminders)
      .set({ status: "sending", sendingAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(reminders.id, bounce.id));
    await sendReminderBatch(batchId, { round: 9, pauseMs: 0 });
    expect((await batchDetail(batchId))!.recipients.find((r) => r.id === bounce.id)).toMatchObject({
      status: "failed",
    });
    expect((await batchDetail(batchId))!.batch.status).toBe("sent");
  });

  it("needs email sending, someone ticked, and can be discarded", async () => {
    const { admin, bot } = await setup();
    const id = await saveDeadline(admin, bot.id, PLAN);
    const { batchId } = (await startReminders(admin, id))!;
    // Not written yet.
    await expect(
      sendReminders(admin, batchId, {
        subject: "s",
        body: "Hi {first_name}, send it.",
        leaveOut: [],
      }),
    ).rejects.toThrow(/hasn't finished/);
    await writeReminders(batchId);
    const people = (await batchDetail(batchId))!.recipients.map((r) => r.id);
    await expect(
      sendReminders(admin, batchId, {
        subject: "s",
        body: "Hi {first_name}, send it.",
        leaveOut: people,
      }),
    ).rejects.toThrow(/Nobody is ticked/);
    vi.stubEnv("RESEND_API_KEY", "");
    await expect(
      sendReminders(admin, batchId, {
        subject: "s",
        body: "Hi {first_name}, send it.",
        leaveOut: [],
      }),
    ).rejects.toThrow(/Email sending isn't set up/);
    vi.stubEnv("RESEND_API_KEY", "re_test_not_real");

    await discardReminders(admin, batchId);
    expect((await batchDetail(batchId))!.batch.status).toBe("discarded");
    // A new round can start now.
    expect((await startReminders(admin, id))?.count).toBe(2);
    expect(sent).toHaveLength(0);
  });

  it("starts on schedule from the reminder day, once, and never after the deadline", async () => {
    const { admin, bot } = await setup();
    // Any day of the week, so the test runs the same at weekends.
    await saveReminderPlan(admin, bot.id, { ...DEFAULT_PLAN, weekdaysOnly: false });
    const today = londonDate();
    const inDays = (n: number) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const soon = await saveDeadline(admin, bot.id, { ...PLAN, dueOn: inDays(5) });
    const later = await saveDeadline(admin, bot.id, { ...PLAN, name: "Later", dueOn: inDays(30) });
    const byHand = await saveDeadline(admin, bot.id, {
      ...PLAN,
      name: "By hand",
      dueOn: inDays(2),
      remindDaysBefore: 0,
    });
    const passed = await saveDeadline(admin, bot.id, { ...PLAN, name: "Gone", dueOn: inDays(-1) });

    await startScheduledReminders();
    const of = async (id: string) =>
      db.select().from(reminderBatches).where(eq(reminderBatches.deadlineId, id));
    expect(await of(soon)).toHaveLength(1);
    expect(await of(later)).toHaveLength(0);
    expect(await of(byHand)).toHaveLength(0);
    expect(await of(passed)).toHaveLength(0);
    // Discarded, it isn't started again for the same reminder day.
    const [b] = await of(soon);
    await discardReminders(admin, b.id);
    await startScheduledReminders();
    expect(await of(soon)).toHaveLength(1);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, bot.id), eq(auditLog.actorType, "system")));
    expect(audit.map((a) => a.summary)).toContain(
      'Billie started drafting 2 reminders for "Stand plan"',
    );
  });

  it("are in privacy requests by email, and go with retention", async () => {
    const { admin, bot, e } = await setup();
    const id = await saveDeadline(admin, bot.id, PLAN);
    const { batchId } = (await startReminders(admin, id))!;
    expect(await findPerson(e.kite)).toMatchObject({ reminders: 1, exhibitors: 1 });
    expect(await deletePerson(admin, e.kite)).toMatchObject({ reminders: 1, exhibitors: 1 });
    expect((await batchDetail(batchId))!.recipients.map((r) => r.company)).toEqual(["Acme Ltd"]);

    await db
      .update(reminderBatches)
      .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(reminderBatches.id, batchId));
    const counts = await runRetention();
    expect(counts.reminderRounds).toBeGreaterThanOrEqual(1);
    expect(await batchDetail(batchId)).toBeNull();
    expect(await db.select().from(reminders).where(eq(reminders.batchId, batchId))).toHaveLength(0);
    // The deadline itself stays.
    expect(await db.query.deadlines.findFirst({ where: eq(deadlines.id, id) })).toBeTruthy();
  });
});

const dayFrom = (today: string, n: number) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe.skipIf(!hasDb)("how often reminders go", () => {
  beforeAll(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test_not_real");
    vi.stubEnv("EMAIL_FROM", "Billie <billie@media10.test>");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    sent.length = 0;
  });

  /** A first round, checked and sent `ago` days ago (as if the schedule had run then). */
  async function sentRound(ago: number) {
    const { admin, bot, e, rows } = await setup();
    const today = londonDate();
    // Only "Yes" is done: Acme (No), Kite (no answer) and Oak (Approved) get it.
    const id = await saveDeadline(admin, bot.id, {
      ...PLAN,
      doneValues: ["yes"],
      dueOn: dayFrom(today, 3),
      remindDaysBefore: 14,
    });
    const { batchId } = (await startReminders(admin, id))!;
    await writeReminders(batchId);
    await sendReminders(admin, batchId, {
      subject: "Your stand plan for {stand}",
      body: "Hi {first_name},\n\nPlease send the stand plan for {company} by Sunday 14 February.",
      leaveOut: [],
    });
    await sendReminderBatch(batchId, { round: 1, pauseMs: 0 });
    await db
      .update(reminderBatches)
      .set({ createdAt: daysAgo(ago), sentAt: daysAgo(ago) })
      .where(eq(reminderBatches.id, batchId));
    await db
      .update(reminders)
      .set({ sentAt: daysAgo(ago) })
      .where(eq(reminders.batchId, batchId));
    sent.length = 0;
    return { admin, bot, e, rows, id, batchId };
  }

  const roundsOf = (id: string) =>
    db.select().from(reminderBatches).where(eq(reminderBatches.deadlineId, id));

  it("is one round by default, and saved with a note in the audit log", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    expect(await reminderPlan(bot.id)).toEqual(DEFAULT_PLAN);
    const weekly = { repeatDays: 7, autoSend: true, gapDays: 3, weekdaysOnly: false } as const;
    await saveReminderPlan(admin, bot.id, weekly);
    expect(await reminderPlan(bot.id)).toEqual(weekly);
    await expect(
      saveReminderPlan(admin, bot.id, { ...weekly, repeatDays: 5 as 7 }),
    ).rejects.toThrow(/from the options/);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, bot.id));
    expect(audit.map((a) => a.summary)).toContain(
      "Set deadline reminders to again every 7 days until done, sent automatically, at most one email in 3 days",
    );
  });

  it("sends the approved email again a week later, to those still not done, without asking Claude", async () => {
    const { admin, bot, e, rows, id, batchId } = await sentRound(8);
    await saveReminderPlan(admin, bot.id, {
      repeatDays: 7,
      autoSend: true,
      gapDays: 2,
      weekdaysOnly: false,
    });
    // Since then: Acme's plan is approved, and Kite had another reminder yesterday.
    await uploadList(admin, bot.id, {
      name: "list.csv",
      bytes: csv(rows.map((r) => (r[0] === "Acme Ltd" ? [...r.slice(0, 4), "Yes", r[5]] : r))),
    });
    const [kite] = await db
      .select()
      .from(reminders)
      .where(and(eq(reminders.batchId, batchId), eq(reminders.company, "Kite Stands")));
    await db
      .update(reminders)
      .set({ sentAt: daysAgo(1) })
      .where(eq(reminders.id, kite.id));

    // (Other tests' deadlines share the database: this one's rounds are what count.)
    await startScheduledReminders();
    const repeat = (await roundsOf(id)).find((b) => b.round === 2)!;
    expect(repeat).toMatchObject({
      status: "sending",
      subject: "Reminder: Your stand plan for {stand}",
      body: "Hi {first_name},\n\nPlease send the stand plan for {company} by Sunday 14 February.",
      sentBy: null,
    });
    // No new draft: the wording was already checked.
    const drafts = await db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, `reminders:${repeat.id}`));
    expect(drafts).toHaveLength(0);
    // Acme has done it since, and Kite had a reminder yesterday: only Oak gets it.
    const people = await db.select().from(reminders).where(eq(reminders.batchId, repeat.id));
    expect(people.map((p) => [p.company, p.status])).toEqual([["Oak Builds", "queued"]]);
    await sendReminderBatch(repeat.id, { round: 1, pauseMs: 0 });
    expect(sent).toEqual([
      expect.objectContaining({ to: [e.oak], subject: "Reminder: Your stand plan for stand A1" }),
    ]);
    // Once a week: nothing more today.
    await startScheduledReminders();
    expect(await roundsOf(id)).toHaveLength(2);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, bot.id));
    expect(audit.map((a) => a.summary)).toContain(
      'Billie sent 1 reminder for "Stand plan" again (round 2), in the wording sent before',
    );
  });

  it("waits for a person to check a repeat, unless the plan says otherwise", async () => {
    const { admin, bot, id } = await sentRound(8);
    await saveReminderPlan(admin, bot.id, {
      repeatDays: 7,
      autoSend: false,
      gapDays: 2,
      weekdaysOnly: false,
    });
    await startScheduledReminders();
    const repeat = (await roundsOf(id)).find((b) => b.round === 2)!;
    expect(repeat.status).toBe("ready");
    const detail = (await batchDetail(repeat.id))!;
    expect(detail.plan.repeatDays).toBe(7);
    expect(detail.recipients.map((r) => [r.company, r.status])).toEqual([
      ["Acme Ltd", "pending"],
      ["Kite Stands", "pending"],
      ["Oak Builds", "pending"],
    ]);
    expect(sent).toHaveLength(0);
  });

  it("doesn't repeat too soon, at weekends when asked not to, or with one round only", async () => {
    const { admin, bot, id } = await sentRound(3);
    await saveReminderPlan(admin, bot.id, { ...DEFAULT_PLAN, repeatDays: 7, autoSend: true });
    await startScheduledReminders(); // sent 3 days ago: too soon
    expect(await roundsOf(id)).toHaveLength(1);
    await db
      .update(reminderBatches)
      .set({ createdAt: daysAgo(8), sentAt: daysAgo(8) })
      .where(eq(reminderBatches.deadlineId, id));
    await db
      .update(reminders)
      .set({ sentAt: daysAgo(8) })
      .where(
        sql`${reminders.batchId} IN (SELECT id FROM reminder_batches WHERE deadline_id = ${id})`,
      );
    // A Saturday, with weekdays only: nothing.
    const today = londonDate();
    const sat = [0, 1, 2, 3, 4, 5, 6]
      .map((n) => dayFrom(today, -n))
      .find((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 6)!;
    await startScheduledReminders(new Date(`${sat}T10:00:00Z`));
    expect(await roundsOf(id)).toHaveLength(1);
    await saveReminderPlan(admin, bot.id, { ...DEFAULT_PLAN, repeatDays: 0, weekdaysOnly: false });
    await startScheduledReminders(); // one round only
    expect(await roundsOf(id)).toHaveLength(1);
    // Weekly again, on a weekday: it goes.
    await saveReminderPlan(admin, bot.id, { ...DEFAULT_PLAN, repeatDays: 7, weekdaysOnly: false });
    await startScheduledReminders();
    expect(await roundsOf(id)).toHaveLength(2);
  });

  it("adds the deadline's link to the drafted email", async () => {
    const { admin, bot } = await setup();
    await db
      .update(bots)
      .set({
        links: [
          {
            id: "lplan01",
            label: "Upload your stand plan",
            url: "https://manual.ukcw.test/plans",
            when: "",
          },
        ],
      })
      .where(eq(bots.id, bot.id));
    await expect(saveDeadline(admin, bot.id, { ...PLAN, linkId: "lnope" })).rejects.toThrow(
      /isn't one of the bot's links/,
    );
    const id = await saveDeadline(admin, bot.id, { ...PLAN, linkId: "lplan01" });
    expect((await deadlineSetup(bot.id)).deadlines[0].linkId).toBe("lplan01");
    const { batchId } = (await startReminders(admin, id))!;
    await writeReminders(batchId);
    const body = (await batchDetail(batchId))!.batch.body;
    expect(body).toContain("\n\nUpload your stand plan: https://manual.ukcw.test/plans\n\n");
  });

  it("shows a signed-in exhibitor what's still to do, and tells Billie", async () => {
    const { admin, bot: made, e } = await setup();
    await db
      .update(bots)
      .set({
        personalAnswers: true,
        links: [
          {
            id: "lbadge1",
            label: "Get your badges",
            url: "https://visitconnect.test/ukcw",
            when: "",
          },
        ],
      })
      .where(eq(bots.id, made.id));
    await saveDeadline(admin, made.id, PLAN);
    await saveDeadline(admin, made.id, {
      name: "Nameboard",
      dueOn: "2027-01-20",
      column: "Nameboard",
      doneValues: ["*any"],
      remindDaysBefore: 0,
      linkId: "lbadge1",
    });
    const bot = (await botById(made.id))!;
    const [acme] = await db
      .select()
      .from(exhibitors)
      .where(and(eq(exhibitors.botId, bot.id), eq(exhibitors.stand, "B12")));
    const { conversation } = await startConversation({ bot, channel: "web" });
    expect((await visitorUpdates(bot, conversation, null)).checklist).toBeUndefined();
    await db
      .update(conversations)
      .set({ exhibitorId: acme.id, signedInEmail: e.acme, signedInAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    const signed = (await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    }))!;
    // Acme: the nameboard is in (a date), the stand plan isn't approved yet.
    expect((await visitorUpdates(bot, signed, null)).checklist).toEqual([
      { id: expect.any(String), name: "Nameboard", due: "2027-01-20", state: "done" },
      { id: expect.any(String), name: "Stand plan", due: "2027-02-14", state: "todo" },
    ]);
    // A column the team keeps from Billie isn't shown.
    await db.execute(
      sql`UPDATE exhibitor_lists SET hidden_columns = '["Stand plan approved"]'::jsonb WHERE bot_id = ${bot.id}`,
    );
    const hidden = await exhibitorChecklist(bot, await taskExhibitor(signed));
    expect(hidden.map((i) => i.name)).toEqual(["Nameboard"]);
    expect((await visitorUpdates(bot, signed, null)).checklist).toBeUndefined();
  });
});
