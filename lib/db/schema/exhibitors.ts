import { date, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { users } from "./users";

/**
 * A bot's exhibitor list (lib/exhibitors/list.ts), uploaded by the team as
 * a spreadsheet: one row per exhibitor, with the columns the team chose
 * (stand type, orders, stand plan, build-up time). Signed-in exhibitors get
 * answers from their own row; deadline chasers use it to see who's missing
 * something. A new upload replaces the whole list.
 */
export const exhibitors = pgTable(
  "exhibitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    company: text("company").notNull().default(""),
    stand: text("stand").notNull().default(""),
    /** The contact's name. */
    name: text("name").notNull().default(""),
    /** Lower case; an exhibitor can sign in with any of them. */
    emails: text("emails").array().notNull().default([]),
    /** Every other column of the list, by its heading. */
    fields: jsonb("fields").$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("exhibitors_bot_idx").on(t.botId),
    index("exhibitors_emails_idx").using("gin", t.emails),
  ],
);

/** About the uploaded list: one per bot. */
export const exhibitorLists = pgTable("exhibitor_lists", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  /** The headings of the columns kept as fields, in order. */
  columns: jsonb("columns").$type<string[]>().notNull().default([]),
  rows: integer("rows").notNull().default(0),
  /** Rows left out (no email address). */
  skipped: integer("skipped").notNull().default(0),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A deadline exhibitors must meet (stand plan, nameboard, electrics), and the
 * column of the exhibitor list that shows who has met it. Billie drafts
 * reminders to the rest; a person checks them and sends them all at once
 * (lib/exhibitors/deadlines.ts).
 */
export const deadlines = pgTable(
  "deadlines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The date it's due, in UK time. */
    dueOn: date("due_on", { mode: "string" }).notNull(),
    /** The heading of the list column that shows it's done. */
    column: text("column").notNull(),
    /** The answers in that column that mean done, lower case ("*any": any answer). */
    doneValues: text("done_values").array().notNull().default([]),
    /** Billie drafts reminders this many days before (0: only when someone asks). */
    remindDaysBefore: integer("remind_days_before").notNull().default(7),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("deadlines_bot_idx").on(t.botId)],
);

export type ReminderBatchStatus =
  "drafting" | "ready" | "sending" | "sent" | "discarded" | "failed";

/** One round of reminders for a deadline: one email, written once, sent to each exhibitor. */
export const reminderBatches = pgTable(
  "reminder_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deadlineId: uuid("deadline_id")
      .notNull()
      .references(() => deadlines.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    status: text("status").$type<ReminderBatchStatus>().notNull().default("drafting"),
    subject: text("subject").notNull().default(""),
    /** With {first_name}, {company} and {stand} filled in for each exhibitor. */
    body: text("body").notNull().default(""),
    /** What the knowledge didn't say, or why drafting failed. */
    note: text("note").notNull().default(""),
    sources: jsonb("sources").$type<{ title: string; label: string }[]>().notNull().default([]),
    /** Who asked for it (none when Billie drafted it on schedule). */
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reminder_batches_deadline_idx").on(t.deadlineId, t.createdAt),
    index("reminder_batches_bot_status_idx").on(t.botId, t.status),
  ],
);

export type ReminderStatus = "pending" | "left_out" | "queued" | "sent" | "failed";

/** One exhibitor in a batch, as they were on the list when it was drafted. */
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => reminderBatches.id, { onDelete: "cascade" }),
    exhibitorId: uuid("exhibitor_id").references(() => exhibitors.id, { onDelete: "set null" }),
    company: text("company").notNull().default(""),
    stand: text("stand").notNull().default(""),
    name: text("name").notNull().default(""),
    /** Lower case: every address on their row of the list. */
    to: text("to").array().notNull(),
    status: text("status").$type<ReminderStatus>().notNull().default("pending"),
    /** Why it was left out, or why sending failed. */
    note: text("note").notNull().default(""),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reminders_batch_idx").on(t.batchId), index("reminders_to_idx").using("gin", t.to)],
);
