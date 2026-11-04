import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { users } from "./users";

/**
 * A bot's exhibitor list (lib/exhibitors/list.ts), uploaded by the team as
 * a spreadsheet: one row per exhibitor, with the columns the team chose
 * (stand type, orders, stand plan, build-up time). Signed-in exhibitors get
 * answers from their own row; deadline chasers use it to see who's missing
 * something. A new upload replaces the whole list; BluePrint, the exhibitor
 * manual, can keep it up to date instead (lib/exhibitors/blueprint.ts).
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
    /**
     * BluePrint's own id for the exhibitor, on a list BluePrint keeps up to
     * date: the same exhibitor keeps the same row, so their sign-ins last.
     */
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("exhibitors_bot_idx").on(t.botId),
    index("exhibitors_emails_idx").using("gin", t.emails),
    uniqueIndex("exhibitors_bot_external_idx").on(t.botId, t.externalId),
  ],
);

export type ListSource = "upload" | "blueprint";

/** About the uploaded list: one per bot. */
export const exhibitorLists = pgTable("exhibitor_lists", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  /** The headings of the columns kept as fields, in order. */
  columns: jsonb("columns").$type<string[]>().notNull().default([]),
  /** Columns the team keeps to itself: never in what Billie reads about an exhibitor. */
  hiddenColumns: jsonb("hidden_columns").$type<string[]>().notNull().default([]),
  rows: integer("rows").notNull().default(0),
  /** Rows left out (no email address). */
  skipped: integer("skipped").notNull().default(0),
  /** A spreadsheet someone uploaded, or the list BluePrint sends. */
  source: text("source").$type<ListSource>().notNull().default("upload"),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A bot's link to BluePrint, the exhibitor manual (lib/exhibitors/blueprint.ts).
 * One key per bot, made by an admin and shown once: BluePrint sends it to
 * update the exhibitor list, and signs exhibitors in to the chat with a key
 * made from it. Neither the key nor anything that could update the list is
 * kept: only its hash, and the signing key (which can only sign people in).
 */
export const blueprintLinks = pgTable("blueprint_links", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  /** The key's public part (bp_<keyId>_…): which bot a request or sign-in is for. */
  keyId: text("key_id").notNull().unique(),
  /** SHA-256 of the whole key. */
  keyHash: text("key_hash").notNull(),
  /** What BluePrint signs sign-ins with (hex): made from the key, never the key itself. */
  signingKey: text("signing_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** The last list update BluePrint sent. */
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  /** The last exhibitor it signed in to a chat. */
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
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

export type ReminderStatus = "pending" | "left_out" | "queued" | "sending" | "sent" | "failed";

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
    /** When a send job claimed it ("sending"): a job that died is picked up after a while. */
    sendingAt: timestamp("sending_at", { withTimezone: true }),
    /** Times the team tried it again after it failed (part of its key at Resend). */
    retries: integer("retries").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reminders_batch_idx").on(t.batchId), index("reminders_to_idx").using("gin", t.to)],
);
