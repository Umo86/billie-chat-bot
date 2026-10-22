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
};

export type EmailTags = {
  topic: string;
  company: string | null;
  stand: string | null;
  urgency: "low" | "normal" | "high";
};
