import {
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ContactDetails, RequestAnswer } from "@/lib/types";
import { requestStatus } from "./enums";
import { bots } from "./bots";
import { conversations } from "./conversations";
import { users } from "./users";

/**
 * A request someone made through a chat (extra build-up hours, a vehicle on
 * a stand…): the form they filled in, who handles it, its status, and the
 * team's latest message to them. They follow it on a page of its own
 * (/r/<token>), and get an email when it changes if email is set up.
 */
export const chatRequests = pgTable(
  "chat_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Shown as R-1001 and so on. */
    ref: serial("ref").notNull(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    typeId: text("type_id").notNull(),
    typeName: text("type_name").notNull(),
    status: requestStatus("status").notNull().default("new"),
    answers: jsonb("answers").$type<RequestAnswer[]>().notNull().default([]),
    contact: jsonb("contact").$type<ContactDetails>().notNull().default({}),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    /** The team's latest message to the person, shown on their page. */
    note: text("note").notNull().default(""),
    /** The person's link to their request's page. */
    trackToken: text("track_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("chat_requests_ref_unique").on(t.ref),
    uniqueIndex("chat_requests_track_unique").on(t.trackToken),
    index("chat_requests_status_idx").on(t.status, t.createdAt),
    index("chat_requests_bot_idx").on(t.botId),
    index("chat_requests_conversation_idx").on(t.conversationId),
    index("chat_requests_assigned_idx").on(t.assignedTo),
  ],
);
