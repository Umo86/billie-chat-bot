import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  boolean,
} from "drizzle-orm/pg-core";
import type { BotRules, CheckIssue, TestQuestion, TestRun } from "@/lib/types";
import { audience, botStatus, checkStatus, quality, sourceKind, sourceStatus, tone } from "./enums";
import { users } from "./users";

/** Postgres full-text search vector (generated from a passage's label and text). */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/** Embedding size: Voyage voyage-4 at its default 1024 dimensions (lib/knowledge/embed.ts). */
export const EMBEDDING_DIMENSIONS = 1024;

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const bots = pgTable(
  "bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Public handle in the embed code and hosted link; never reused while the bot exists. */
    slug: text("slug").notNull(),
    audience: audience("audience").notNull().default("exhibitors"),
    showName: text("show_name").notNull().default(""),
    color: text("color").notNull().default("#0d6a5b"),
    avatarUrl: text("avatar_url"),
    welcome: text("welcome").notNull().default(""),
    starters: jsonb("starters").$type<string[]>().notNull().default([]),
    tone: tone("tone").notNull().default("friendly"),
    /** How it should come across, in the team's own words (style only; the rules always win). */
    personality: text("personality").notNull().default(""),
    /** The odd emoji in chats (never in emails). */
    emoji: boolean("emoji").notNull().default(false),
    /** Ends this bot's email drafts; empty uses the company signature in Settings. */
    emailSignOff: text("email_sign_off").notNull().default(""),
    /**
     * The event's Teams channel (a Teams Workflows webhook link): new email
     * drafts and chats that need a person are posted there. Set by admins only.
     */
    teamsWebhookUrl: text("teams_webhook_url"),
    quality: quality("quality").notNull().default("fast"),
    status: botStatus("status").notNull().default("draft"),
    /** Websites allowed to show the chat (hostnames, e.g. "ukconstructionweek.com"). */
    domains: jsonb("domains").$type<string[]>().notNull().default([]),
    rules: jsonb("rules").$type<BotRules>().notNull(),
    tests: jsonb("tests").$type<TestQuestion[]>().notNull().default([]),
    lastTestRun: jsonb("last_test_run").$type<TestRun | null>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("bots_slug_unique").on(t.slug),
    index("bots_created_by_idx").on(t.createdBy),
    index("bots_status_idx").on(t.status),
  ],
);

/**
 * The event's Outlook mailbox for a bot (one each). New emails get a draft
 * reply from the bot's knowledge, saved in the mailbox's Drafts, and a post
 * in the bot's Teams channel naming the person who manages the mailbox.
 */
export const botMailboxes = pgTable(
  "bot_mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    /** The mailbox's address in Microsoft 365, lower case. */
    address: text("address").notNull(),
    /** Who manages the mailbox: named in the Teams post for every new draft. */
    assignedUserId: uuid("assigned_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    enabled: boolean("enabled").notNull().default(true),
    /** Microsoft Graph delta link: where the next sync of this mailbox carries on from. */
    deltaLink: text("delta_link"),
    /**
     * Billie only takes mail received from here on: set at its first sync,
     * and again when the mailbox is switched back on or its address changes
     * (null until then). Mail from before is never drafted.
     */
    syncFrom: timestamp("sync_from", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** Why the last sync failed, in words for the screen (null when it worked). */
    lastError: text("last_error"),
    /** Why the last reply couldn't be saved in Drafts, in words (null once one is saved). */
    draftError: text("draft_error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("bot_mailboxes_bot_unique").on(t.botId),
    uniqueIndex("bot_mailboxes_address_unique").on(t.address),
    index("bot_mailboxes_assigned_idx").on(t.assignedUserId),
  ],
);

export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("knowledge_bases_created_by_idx").on(t.createdBy)],
);

/** Which knowledge bases a bot answers from (a shared one can sit under several bots). */
export const botKnowledgeBases = pgTable(
  "bot_knowledge_bases",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.knowledgeBaseId] }),
    index("bot_knowledge_bases_kb_idx").on(t.knowledgeBaseId),
  ],
);

/** One file, pasted text, typed answer or web page in a knowledge base. */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: sourceKind("kind").notNull(),
    status: sourceStatus("status").notNull().default("queued"),
    error: text("error"),
    /** Original file: name as uploaded, where it is stored (lib/storage.ts), size and type. */
    fileName: text("file_name"),
    fileKey: text("file_key"),
    fileSize: integer("file_size"),
    mimeType: text("mime_type"),
    /** Web pages: the address, re-read every week when refreshWeekly is on. */
    url: text("url"),
    refreshWeekly: boolean("refresh_weekly").notNull().default(false),
    /** Pasted text and typed answers keep their text here (files and pages are re-read). */
    body: text("body"),
    contentHash: text("content_hash"),
    chars: integer("chars").notNull().default(0),
    passageCount: integer("passage_count").notNull().default(0),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("sources_kb_idx").on(t.knowledgeBaseId),
    index("sources_status_idx").on(t.status),
    index("sources_added_by_idx").on(t.addedBy),
  ],
);

/** A short passage of a source: what search finds and what Claude answers from. */
export const passages = pgTable(
  "passages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    /** Where in the source, e.g. "p. 4", "Sheet: Prices", "Typed answer". */
    label: text("label").notNull().default(""),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(label, '') || ' ' || text)`,
    ),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("passages_source_idx").on(t.sourceId, t.ordinal),
    index("passages_kb_idx").on(t.knowledgeBaseId),
    index("passages_search_idx").using("gin", t.search),
    index("passages_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

/**
 * A knowledge check: Claude reads a whole knowledge base and lists
 * contradictions, dates that have passed and contact details that don't
 * match. Kept so the team sees the latest result, and when it was made.
 */
export const knowledgeChecks = pgTable(
  "knowledge_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    status: checkStatus("status").notNull().default("queued"),
    issues: jsonb("issues").$type<CheckIssue[]>().notNull().default([]),
    /** How much was checked: everything, unless the knowledge base is very large. */
    checkedSources: integer("checked_sources").notNull().default(0),
    totalSources: integer("total_sources").notNull().default(0),
    error: text("error"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("knowledge_checks_kb_idx").on(t.knowledgeBaseId, t.createdAt),
    index("knowledge_checks_requested_by_idx").on(t.requestedBy),
  ],
);
