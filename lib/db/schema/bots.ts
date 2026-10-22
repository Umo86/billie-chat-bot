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
import type { BotRules, TestQuestion, TestRun } from "@/lib/types";
import { audience, botStatus, quality, sourceKind, sourceStatus, tone } from "./enums";
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
