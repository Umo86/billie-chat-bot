import { z } from "zod";

/**
 * The JSON Claude must reply with (structured outputs: output_config.format)
 * and the zod check every reply passes before Billie uses it. Kept to the
 * JSON Schema features structured outputs support: objects with
 * additionalProperties false, strings, integers, booleans, enums, arrays.
 */
export const HANDOVER_VALUES = ["none", "unknown", "always_human", "asked_for_person"] as const;

export const answerJsonSchema = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The reply to the person, plain text." },
    used: {
      type: "array",
      items: { type: "integer" },
      description: "Numbers of the passages the answer relies on.",
    },
    confident: { type: "boolean" },
    handover: { type: "string", enum: [...HANDOVER_VALUES] },
    topic: { type: "string", description: "Two to four word topic." },
    request: {
      type: "string",
      description: "The id of the request form to offer, or an empty string.",
    },
  },
  required: ["answer", "used", "confident", "handover", "topic", "request"],
  additionalProperties: false,
} as const;

export const answerSchema = z.object({
  answer: z.string(),
  used: z.array(z.number().int()),
  confident: z.boolean(),
  handover: z.enum(HANDOVER_VALUES),
  topic: z.string(),
  request: z.string().optional().default(""),
});
export type AnswerJson = z.infer<typeof answerSchema>;

export const EMAIL_TOPICS = [
  "Stand build",
  "Furniture",
  "Badges",
  "Deliveries",
  "Vehicles and parking",
  "Electrics and services",
  "Payments",
  "Complaints",
  "Health and safety",
  "Sponsorship",
  "Other",
] as const;

export const emailTagJsonSchema = {
  type: "object",
  properties: {
    topic: { type: "string", enum: [...EMAIL_TOPICS] },
    company: { type: "string", description: "The exhibitor's company, or an empty string." },
    stand: { type: "string", description: "The stand number, or an empty string." },
    urgency: { type: "string", enum: ["low", "normal", "high"] },
    always_human: { type: "boolean" },
    summary: { type: "string", description: "One short sentence on what the sender wants." },
  },
  required: ["topic", "company", "stand", "urgency", "always_human", "summary"],
  additionalProperties: false,
} as const;

export const emailTagSchema = z.object({
  topic: z.enum(EMAIL_TOPICS),
  company: z.string(),
  stand: z.string(),
  urgency: z.enum(["low", "normal", "high"]),
  always_human: z.boolean(),
  summary: z.string(),
});
export type EmailTagJson = z.infer<typeof emailTagSchema>;

export const emailDraftJsonSchema = {
  type: "object",
  properties: {
    draft: { type: "string", description: "The full reply, plain text." },
    used: { type: "array", items: { type: "integer" } },
    confident: { type: "boolean" },
    missing: { type: "string", description: "What the passages don't cover, or an empty string." },
    holding: {
      type: "string",
      description: "A short holding reply if not confident, or an empty string.",
    },
  },
  required: ["draft", "used", "confident", "missing", "holding"],
  additionalProperties: false,
} as const;

export const emailDraftSchema = z.object({
  draft: z.string(),
  used: z.array(z.number().int()),
  confident: z.boolean(),
  missing: z.string(),
  holding: z.string(),
});
export type EmailDraftJson = z.infer<typeof emailDraftSchema>;

export const CHECK_KINDS = ["contradiction", "date_passed", "contact", "unclear"] as const;

export const knowledgeCheckJsonSchema = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...CHECK_KINDS] },
          title: { type: "string", description: "The problem in a few words." },
          detail: {
            type: "string",
            description: "What's wrong and what to change, in one or two plain sentences.",
          },
          quotes: {
            type: "array",
            items: { type: "string" },
            description: "The exact words from the knowledge, one per place.",
          },
          sources: {
            type: "array",
            items: { type: "string" },
            description: "The labels of the sources involved, e.g. S3.",
          },
        },
        required: ["kind", "title", "detail", "quotes", "sources"],
        additionalProperties: false,
      },
    },
  },
  required: ["issues"],
  additionalProperties: false,
} as const;

export const knowledgeCheckSchema = z.object({
  issues: z
    .array(
      z.object({
        kind: z.enum(CHECK_KINDS),
        title: z.string(),
        detail: z.string(),
        quotes: z.array(z.string()),
        sources: z.array(z.string()),
      }),
    )
    .max(50),
});
export type KnowledgeCheckJson = z.infer<typeof knowledgeCheckSchema>;

export const learnFromSentJsonSchema = {
  type: "object",
  properties: {
    learned: { type: "boolean" },
    question: { type: "string", description: "As an exhibitor would ask it, or empty." },
    answer: { type: "string", description: "The team's fact, a sentence or two, or empty." },
    why: { type: "string", description: "What changed, in a few words, or empty." },
  },
  required: ["learned", "question", "answer", "why"],
  additionalProperties: false,
} as const;

export const learnFromSentSchema = z.object({
  learned: z.boolean(),
  question: z.string(),
  answer: z.string(),
  why: z.string(),
});
export type LearnFromSentJson = z.infer<typeof learnFromSentSchema>;

export const reminderJsonSchema = {
  type: "object",
  properties: {
    subject: { type: "string", description: "The email's subject line." },
    body: {
      type: "string",
      description: "The email, from the greeting to the last line, with no sign-off.",
    },
    used: { type: "array", items: { type: "integer" }, description: "Passage numbers used." },
    missing: {
      type: "string",
      description:
        "What the passages don't say that exhibitors need (how or where to do it), or empty.",
    },
  },
  required: ["subject", "body", "used", "missing"],
  additionalProperties: false,
} as const;

export const reminderSchema = z.object({
  subject: z.string(),
  body: z.string(),
  used: z.array(z.number()),
  missing: z.string(),
});
export type ReminderJson = z.infer<typeof reminderSchema>;

export const historyJsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "A general question any exhibitor might ask, as they would ask it.",
          },
          answer: {
            type: "string",
            description: "The team's answer, as their replies give it, in one to three sentences.",
          },
          emails: {
            type: "array",
            items: { type: "integer" },
            description: "The numbers of the emails that asked it.",
          },
        },
        required: ["question", "answer", "emails"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

export const historySchema = z.object({
  items: z
    .array(
      z.object({
        question: z.string(),
        answer: z.string(),
        emails: z.array(z.number().int()),
      }),
    )
    .max(40),
});
export type HistoryJson = z.infer<typeof historySchema>;
