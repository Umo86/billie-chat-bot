import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  customType,
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
  vector,
  boolean,
} from "drizzle-orm/pg-core";
import type { BotRules, CheckIssue, RequestType, TestQuestion, TestRun } from "@/lib/types";
import {
  answerLength,
  audience,
  barMascot,
  launcherStyle,
  botStatus,
  checkStatus,
  quality,
  sourceKind,
  sourceStatus,
  tone,
} from "./enums";
import { users } from "./users";
import type { PageStarters } from "@/lib/bots/page-starters";
import type { HandoverRoute } from "@/lib/conversations/routes";

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
    /** The show's days, from the first of build-up to the last of breakdown (UK dates). */
    showStartsOn: date("show_starts_on", { mode: "string" }),
    showEndsOn: date("show_ends_on", { mode: "string" }),
    color: text("color").notNull().default("#0d6a5b"),
    avatarUrl: text("avatar_url"),
    /** Buttons, starters and the person's own messages; null uses the header colour. */
    accentColor: text("accent_color"),
    /** The show's logo, at the right of the chat's header (a small WebP or PNG data URL). */
    logoUrl: text("logo_url"),
    /** Words on the website's chat button, e.g. "Ask Billie"; empty shows just the icon. */
    launcherLabel: text("launcher_label").notNull().default(""),
    /** A round button, or a bar along the bottom of the page. */
    launcherStyle: launcherStyle("launcher_style").notNull().default("button"),
    /** The bar's opening words, e.g. "Ask me about". */
    barLead: text("bar_lead").notNull().default("Ask me about"),
    /** Topics the bar cycles through after its opening words. */
    barTopics: text("bar_topics")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    barMascot: barMascot("bar_mascot").notNull().default("robot"),
    /** The robot bobs and blinks and the topics slide in; off keeps the bar still. */
    barMotion: boolean("bar_motion").notNull().default(true),
    welcome: text("welcome").notNull().default(""),
    starters: jsonb("starters").$type<string[]>().notNull().default([]),
    /** Who handles what: chats and emails about a topic go to that person first. */
    routes: jsonb("routes").$type<HandoverRoute[]>().notNull().default([]),
    /** Different starters on some pages ("the address contains …"; lib/bots/page-starters.ts). */
    pageStarters: jsonb("page_starters").$type<PageStarters[]>().notNull().default([]),
    tone: tone("tone").notNull().default("friendly"),
    /** How it should come across, in the team's own words (style only; the rules always win). */
    personality: text("personality").notNull().default(""),
    /** The odd emoji in chats (never in emails). */
    emoji: boolean("emoji").notNull().default(false),
    /** Short, normal or detailed chat answers. */
    answerLength: answerLength("answer_length").notNull().default("normal"),
    /** Uses the person's first name now and then, once they've given it. */
    useName: boolean("use_name").notNull().default(true),
    /** Words and phrases it never uses, in the team's words (one per line or comma). */
    avoidWords: text("avoid_words").notNull().default(""),
    /** Ends this bot's email drafts; empty uses the company signature in Settings. */
    emailSignOff: text("email_sign_off").notNull().default(""),
    /**
     * The event's Teams channel (a Teams Workflows webhook link): new email
     * drafts and chats that need a person are posted there. Set by admins only.
     */
    teamsWebhookUrl: text("teams_webhook_url"),
    /**
     * The event's Slack channel (its id, "C0…"): chats that need a person
     * (two-way, in a thread each), tickets, email drafts to check and the
     * bot's own posts go there once Slack is connected. Set by admins only.
     */
    slackChannelId: text("slack_channel_id"),
    /**
     * The people Billie @mentions in Slack for this bot (People step): its
     * show's team. Billie users, matched to Slack by email; empty is @here.
     */
    slackPeople: uuid("slack_people").array().notNull().default([]),
    quality: quality("quality").notNull().default("fast"),
    status: botStatus("status").notNull().default("draft"),
    /** Websites allowed to show the chat (hostnames, e.g. "ukconstructionweek.com"). */
    domains: jsonb("domains").$type<string[]>().notNull().default([]),
    rules: jsonb("rules").$type<BotRules>().notNull(),
    tests: jsonb("tests").$type<TestQuestion[]>().notNull().default([]),
    /**
     * Exhibitors can sign in from the chat (a code to their email) and get
     * answers from their own row of the exhibitor list (lib/exhibitors).
     */
    personalAnswers: boolean("personal_answers").notNull().default(false),
    /** Requests the bot takes through the chat, as forms (lib/requests/rules.ts). */
    requestTypes: jsonb("request_types").$type<RequestType[]>().notNull().default([]),
    lastTestRun: jsonb("last_test_run").$type<TestRun | null>(),
    /** Copied from this bot for the next show or edition (lib/bots/copy.ts). */
    copiedFromId: uuid("copied_from_id").references((): AnyPgColumn => bots.id, {
      onDelete: "set null",
    }),
    /** When someone said the dates in a copied bot are checked (the list goes away). */
    datesCheckedAt: timestamp("dates_checked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("bots_slug_unique").on(t.slug),
    index("bots_copied_from_idx").on(t.copiedFromId),
    index("bots_created_by_idx").on(t.createdBy),
    index("bots_status_idx").on(t.status),
  ],
);

/**
 * Who works on a bot. Admins work on every bot and need no row; editors
 * manage their bots (settings, knowledge, Inbox, requests, emails, going
 * live) and agents answer their bots' Inbox, requests and emails. Set by
 * admins on the bot's People step; whoever makes a bot is on it.
 */
export const botMembers = pgTable(
  "bot_members",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.userId] }),
    index("bot_members_user_idx").on(t.userId),
    index("bot_members_added_by_idx").on(t.addedBy),
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
    /** Learning from past emails (lib/emails/history.ts): how the last read went. */
    historyStatus: text("history_status").$type<"reading" | "done" | "failed">(),
    historyNote: text("history_note"),
    historyAt: timestamp("history_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("bot_mailboxes_bot_unique").on(t.botId),
    uniqueIndex("bot_mailboxes_address_unique").on(t.address),
    index("bot_mailboxes_assigned_idx").on(t.assignedUserId),
  ],
);

/**
 * What a bot knows. Every bot has exactly one, made with the bot and named
 * after it; bots never share. botId is null only for an old shared base
 * that no bot answers from any more (shown apart, so it can be deleted).
 */
export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("knowledge_bases_bot_unique").on(t.botId),
    index("knowledge_bases_created_by_idx").on(t.createdBy),
  ],
);

/**
 * Before each bot had its own knowledge, this said which bases a bot
 * answered from. It now mirrors knowledge_bases.bot_id (one row per bot), so
 * rolling back to an older release still answers. Nothing reads it.
 */
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

/**
 * A whole website read into a bot's knowledge (lib/knowledge/websites.ts):
 * its pages come from the sitemap (or the home page's links), each a web
 * page source, and it's read again every week: new pages added, gone ones
 * taken out, changed ones read again.
 */
export const websites = pgTable(
  "websites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    /** What the team typed: the home page, or the sitemap's address. */
    url: text("url").notNull(),
    host: text("host").notNull(),
    /** Pages whose address contains any of these are left out (lower case). */
    leaveOut: text("leave_out").array().notNull().default([]),
    maxPages: integer("max_pages").notNull().default(200),
    status: text("status").$type<"finding" | "ready" | "failed">().notNull().default("finding"),
    /** How the pages were found, or why they couldn't be. */
    note: text("note").notNull().default(""),
    /** Pages found the last time, before leaving any out. */
    found: integer("found").notNull().default(0),
    lastCrawledAt: timestamp("last_crawled_at", { withTimezone: true }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("websites_kb_idx").on(t.knowledgeBaseId)],
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
    /** A page of a whole website the bot reads (its re-reading is the website's). */
    websiteId: uuid("website_id").references((): AnyPgColumn => websites.id, {
      onDelete: "set null",
    }),
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
    index("sources_website_idx").on(t.websiteId),
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
