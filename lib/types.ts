/**
 * Shapes stored in jsonb columns and passed between server and client. Pure
 * types: no imports, safe everywhere.
 */

/** Details Billie can ask for when nobody is online. */
export type ContactField = "name" | "company" | "stand" | "email" | "phone";

export type BotRules = {
  /** Topics Billie never answers itself; they go straight to the team. */
  alwaysHuman: string[];
  /** Days 0 (Sun) … 6 (Sat) and opening times in UK time, e.g. "09:00". */
  hours: { days: number[]; start: string; end: string };
  /** What to collect when nobody is online. */
  collect: ContactField[];
  /** "The team will reply …" — e.g. "by the next working day". */
  promise: string;
};

export type TestQuestion = {
  id: string;
  question: string;
  /** Comma-separated words the answer must mention (optional). */
  mustMention: string;
};

export type TestResult = {
  id: string;
  question: string;
  pass: boolean;
  answer: string;
  handover: HandoverKind;
  missing: string[];
  error?: boolean;
};

export type TestRun = { at: string; passed: number; total: number; results: TestResult[] };

export type HandoverKind = "none" | "unknown" | "always_human" | "asked_for_person";

/** A passage an answer was written from, shown under the answer. */
export type MessageSource = {
  sourceId: string;
  title: string;
  /** e.g. "p. 4" or "Typed answer". */
  label: string;
};

export type ContactDetails = Partial<Record<ContactField, string>>;

/** What the engine records about an answer (never shown to visitors). */
export type AnswerMeta = {
  handover?: HandoverKind;
  confident?: boolean;
  topic?: string;
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  passages?: number;
  error?: string;
  /** The request form offered under this answer (lib/requests/rules.ts). */
  request?: string;
  /** Given again from earlier today, without Claude (lib/ai/reuse.ts). */
  reused?: boolean;
  /** off_topic or suspicious (lib/chat/safety.ts); absent for an ordinary message. */
  flag?: "off_topic" | "suspicious";
  /** The team's links shown as buttons under this answer (lib/bots/links.ts). */
  links?: { label: string; url: string }[];
  /** Told how to sign in: the bot is for signed-in exhibitors only (lib/chat/exhibitors-only.ts). */
  locked?: boolean;
};

export type EmailTags = {
  topic: string;
  company: string | null;
  stand: string | null;
  urgency: "low" | "normal" | "high";
};

/** One thing the knowledge check found (lib/knowledge/check.ts). */
export type CheckIssue = {
  kind: "contradiction" | "date_passed" | "contact" | "unclear";
  title: string;
  /** What's wrong and what to change, in plain words. */
  detail: string;
  /** The exact words from the knowledge. */
  quotes: string[];
  /** The sources involved; id and kind when Billie could match the title. */
  sources: { title: string; id?: string; kind?: "file" | "text" | "qa" | "web" }[];
};

/** A field on a request form: a line, a paragraph or a date. */
export type RequestField = {
  id: string;
  label: string;
  kind: "short" | "long" | "date";
  required: boolean;
};

/** Something the team takes through the chat, e.g. extra build-up hours (lib/requests/rules.ts). */
export type RequestType = {
  id: string;
  name: string;
  /** When the bot offers it, in the team's words. */
  when: string;
  fields: RequestField[];
  /** Who handles it; null means whoever manages the bot's event mailbox. */
  handlerId: string | null;
  /**
   * A task from the exhibitor manual (exhibitor bots): Billie lists it for
   * signed-in exhibitors who haven't done it yet, as a button in the chat.
   */
  task?: boolean;
  /** Only for exhibitors whose list column is one of these (e.g. Stand type: Space only). */
  forColumn?: string | null;
  forValues?: string[];
  /** Things to order, with prices: the chat asks how many of each and shows the total. */
  items?: RequestItem[];
  /** Its deadline (Exhibitors step): its due date, and who has done it, come from there. */
  deadlineId?: string | null;
  /** A lead: each one sent is also sent to Twenty CRM (lib/crm), e.g. "Interested in exhibiting". */
  crm?: boolean;
};

/**
 * A link the team lets the bot share as a button (lib/bots/links.ts): register
 * to visit, get exhibitor badges, update the website listing, order services.
 * The bot only ever shows these, never an address it made up.
 */
export type BotLink = {
  id: string;
  label: string;
  url: string;
  /** When to offer it, in the team's words. */
  when: string;
};

/** Something to order through a request, e.g. a 16A socket, at its price in pounds. */
export type RequestItem = { id: string; name: string; price: number };

/** What was ordered: each item, how many, at what price, and the total (pounds). */
export type RequestOrder = {
  lines: { name: string; quantity: number; price: number }[];
  total: number;
};

/** A task a signed-in exhibitor still has to do, shown as a button in the chat. */
export type ChatTask = { typeId: string; name: string; due: string | null };

/** One thing a signed-in exhibitor has to do before the show (lib/exhibitors/checklist.ts). */
export type ChecklistItem = {
  /** The deadline's id, or "task:<request type id>" for a task with no deadline. */
  id: string;
  name: string;
  /** UK date it's due ("YYYY-MM-DD"), if it has a deadline. */
  due: string | null;
  /** Done by their row of the list; sent through this chat; or still to do. */
  state: "todo" | "sent" | "done";
  /** Still to do, and it can be done in the chat: the task's form. */
  task?: string;
  /** Still to do, somewhere else: the team's link for it (Visit Connect, ASP.events…). */
  link?: { label: string; url: string };
};

/** What the person filled in, with the labels as they were then. */
export type RequestAnswer = { label: string; value: string };

/** The form the chat shows when the person wants to make a request. */
export type RequestOffer = {
  typeId: string;
  name: string;
  fields: RequestField[];
  contact: ContactField[];
  /** Things to order, with prices (pounds). */
  items?: RequestItem[];
  /** What the exhibitor signed in to the chat already gave (prefilled). */
  known?: Partial<Record<ContactField, string>>;
  /** A line under the form: where the details go (a lead for the sales team). */
  promise?: string;
};

export type RequestStatus = "new" | "in_progress" | "done" | "declined";

/**
 * Billie's suggested reply in a chat handed to the team: written from the
 * bot's knowledge when the chat is handed over (or on "Suggest again"),
 * for a person to edit and send. Never sent by itself.
 */
export type ReplySuggestion = {
  status: "writing" | "ready" | "none" | "failed";
  /** The reply (or a holding reply when the knowledge doesn't cover it). */
  text: string;
  /** False when the knowledge doesn't answer it: the text is a holding reply. */
  confident: boolean;
  /** What the knowledge doesn't cover, in a few words. */
  missing: string;
  sources: { title: string; label: string }[];
  /** The last message from the person it answers (newer ones make it out of date). */
  afterMessageId: string | null;
  at: string;
  error?: string;
};

/**
 * What Billie learned from a reply the team changed before sending
 * (lib/emails/learn.ts): a question and answer to save as a typed answer,
 * offered on the Knowledge page until someone saves or dismisses it.
 */
export type SentLearning = {
  status: "offered" | "saved" | "dismissed";
  question: string;
  answer: string;
  /** What changed, in a few words. */
  why: string;
  at: string;
};
