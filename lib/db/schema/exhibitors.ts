import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
