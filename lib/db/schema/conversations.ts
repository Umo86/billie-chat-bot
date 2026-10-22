import {
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnswerMeta, ContactDetails, MessageSource } from "@/lib/types";
import { channel, conversationStatus, gapStatus, handoverReason, messageRole } from "./enums";
import { bots, sources } from "./bots";
import { users } from "./users";

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    channel: channel("channel").notNull(),
    status: conversationStatus("status").notNull().default("bot"),
    /** Web and hosted chats: SHA-256 of the visitor's chat token (lib/chat/token.ts). */
    visitorTokenHash: text("visitor_token_hash"),
    /** WhatsApp: the sender's WhatsApp ID (their number). */
    waId: text("wa_id"),
    contact: jsonb("contact").$type<ContactDetails>().notNull().default({}),
    handoverReason: handoverReason("handover_reason"),
    handoverAt: timestamp("handover_at", { withTimezone: true }),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    firstQuestion: text("first_question").notNull().default(""),
    lastText: text("last_text").notNull().default(""),
    messageCount: integer("message_count").notNull().default(0),
    /** Thumbs-down in a row; two hands the chat over. */
    thumbsDownStreak: integer("thumbs_down_streak").notNull().default(0),
    pageUrl: text("page_url"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last message from the person (WhatsApp's 24-hour reply window counts from here). */
    lastVisitorAt: timestamp("last_visitor_at", { withTimezone: true }),
    /** Staff have read everything up to here (Inbox unread marker). */
    staffReadAt: timestamp("staff_read_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("conversations_status_last_idx").on(t.status, t.lastMessageAt),
    index("conversations_bot_created_idx").on(t.botId, t.createdAt),
    index("conversations_assigned_idx").on(t.assignedTo),
    index("conversations_wa_idx").on(t.waId),
    uniqueIndex("conversations_visitor_token_unique").on(t.visitorTokenHash),
    index("conversations_last_message_idx").on(t.lastMessageAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    text: text("text").notNull(),
    sources: jsonb("sources").$type<MessageSource[]>().notNull().default([]),
    /** Staff replies: who wrote it. */
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    /** Visitor rating of a bot answer: 1 helpful, -1 not helpful. */
    rating: smallint("rating"),
    meta: jsonb("meta").$type<AnswerMeta>().notNull().default({}),
    /** WhatsApp message ID, so a webhook delivered twice is handled once. */
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    index("messages_author_idx").on(t.authorId),
    uniqueIndex("messages_external_unique").on(t.externalId),
  ],
);

/** Questions a bot couldn't answer, grouped by wording; answering one adds a typed answer. */
export const gaps = pgTable(
  "gaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    /** Normalised wording (lib/knowledge/gaps.ts:questionKey). */
    questionKey: text("question_key").notNull(),
    question: text("question").notNull(),
    askCount: integer("ask_count").notNull().default(1),
    status: gapStatus("status").notNull().default("open"),
    answeredSourceId: uuid("answered_source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    firstAskedAt: timestamp("first_asked_at", { withTimezone: true }).notNull().defaultNow(),
    lastAskedAt: timestamp("last_asked_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("gaps_bot_question_unique").on(t.botId, t.questionKey),
    index("gaps_status_idx").on(t.status, t.lastAskedAt),
    index("gaps_answered_source_idx").on(t.answeredSourceId),
  ],
);

/**
 * WhatsApp numbers that have written in: which bot they chose ("Visiting or
 * exhibiting?"), the question waiting for that choice, and the last time
 * they wrote (free-form replies are allowed for 24 hours after it).
 */
export const whatsappContacts = pgTable(
  "whatsapp_contacts",
  {
    waId: text("wa_id").primaryKey(),
    profileName: text("profile_name").notNull().default(""),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    pendingText: text("pending_text"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("whatsapp_contacts_bot_idx").on(t.botId)],
);
