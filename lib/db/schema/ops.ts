import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EmailTags, MessageSource } from "@/lib/types";
import { actorType, auditAction, emailSource, emailStatus, jobStatus } from "./enums";
import { bots } from "./bots";
import { users } from "./users";

/** One exhibitor email: from the Outlook mailbox (Microsoft Graph) or pasted in. */
export const emailThreads = pgTable(
  "email_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: emailSource("source").notNull(),
    /** Outlook message id; unique so a sync run twice adds nothing. */
    externalId: text("external_id"),
    /** Outlook conversation id: the thread the draft reply goes into. */
    threadKey: text("thread_key"),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    fromName: text("from_name").notNull().default(""),
    fromEmail: text("from_email").notNull().default(""),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    status: emailStatus("status").notNull().default("new"),
    tags: jsonb("tags").$type<EmailTags | null>(),
    /** One line on what the sender wants. */
    summary: text("summary").notNull().default(""),
    /** Why it needs a person (always-human topic, or Billie wasn't sure). */
    needsYouReason: text("needs_you_reason"),
    draft: text("draft").notNull().default(""),
    draftSources: jsonb("draft_sources").$type<MessageSource[]>().notNull().default([]),
    /** The reply draft Billie put in Outlook, when the mailbox is connected. */
    outlookDraftId: text("outlook_draft_id"),
    error: text("error"),
    handledBy: uuid("handled_by").references(() => users.id, { onDelete: "set null" }),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("email_threads_external_unique").on(t.externalId),
    index("email_threads_status_idx").on(t.status, t.receivedAt),
    index("email_threads_bot_idx").on(t.botId),
    index("email_threads_handled_by_idx").on(t.handledBy),
  ],
);

/**
 * Background work (reading files, drafting emails, alerts, WhatsApp replies).
 * Claimed with FOR UPDATE SKIP LOCKED, retried with backoff (lib/jobs/queue.ts).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    /** A running job's lease; a job still "running" after this is retried. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    /** Same key while queued or running = enqueued once. */
    dedupeKey: text("dedupe_key"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("jobs_due_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_dedupe_active_unique")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('queued', 'running')`),
  ],
);

/** Company-wide settings: one row, id "main". */
export const settings = pgTable("settings", {
  id: text("id").primaryKey().default("main"),
  companyName: text("company_name").notNull().default("Media10"),
  /** Months chats and emails are kept, then deleted by the daily job. */
  retentionMonths: integer("retention_months").notNull().default(12),
  /** Most Claude answers per day across all bots: a spending safety net. */
  dailyAnswerCap: integer("daily_answer_cap").notNull().default(3000),
  /** Shown in every chat before the first message (UK GDPR notice). */
  consentText: text("consent_text")
    .notNull()
    .default(
      "Billie is an AI assistant. It answers from the show's own information, and the team can see this chat. Chats are kept for 12 months.",
    ),
  /** Where handover alerts go by email (comma-separated), in addition to Teams. */
  alertEmails: text("alert_emails").notNull().default(""),
  weeklySummary: boolean("weekly_summary").notNull().default(true),
  /** WhatsApp: the first reply asks "Visiting or exhibiting?" and routes to these bots. */
  whatsappVisitorBotId: uuid("whatsapp_visitor_bot_id").references(() => bots.id, {
    onDelete: "set null",
  }),
  whatsappExhibitorBotId: uuid("whatsapp_exhibitor_bot_id").references(() => bots.id, {
    onDelete: "set null",
  }),
  /** The bot whose knowledge drafts replies to exhibitor emails. */
  emailBotId: uuid("email_bot_id").references(() => bots.id, { onDelete: "set null" }),
  emailSignature: text("email_signature").notNull().default("Kind regards,\nThe Operations team"),
  /** Outlook delta link: where the next mailbox sync carries on from. */
  outlookDeltaLink: text("outlook_delta_link"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Claude use per day, for the daily cap and Reports. scope = "bot:<id>" or "email". */
export const usageDaily = pgTable(
  "usage_daily",
  {
    day: date("day").notNull(),
    scope: text("scope").notNull(),
    requests: integer("requests").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.scope] })],
);

/** Append-only: a trigger (migration 0001) refuses UPDATE and DELETE. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id"),
    actorType: actorType("actor_type").notNull().default("user"),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    action: auditAction("action").notNull(),
    summary: text("summary").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    index("audit_log_actor_idx").on(t.actorUserId),
    index("audit_log_created_idx").on(t.createdAt),
  ],
);
