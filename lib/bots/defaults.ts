import type { BotRules, ContactField } from "@/lib/types";

/** Ticked by default in step 3 of the wizard (from the build plan). */
export const ALWAYS_HUMAN_DEFAULT = [
  "Payments and refunds",
  "Complaints",
  "Accidents and injuries",
  "Contract or stand-space changes",
];

export const CONTACT_FIELDS: ContactField[] = ["name", "company", "stand", "email", "phone"];

export const FIELD_LABEL: Record<ContactField, string> = {
  name: "Name",
  company: "Company",
  stand: "Stand number",
  email: "Email",
  phone: "Phone",
};

export function defaultRules(audience: "visitors" | "exhibitors"): BotRules {
  return {
    alwaysHuman:
      audience === "visitors" ? ALWAYS_HUMAN_DEFAULT.slice(0, 3) : ALWAYS_HUMAN_DEFAULT.slice(),
    hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30" },
    collect:
      audience === "visitors"
        ? ["name", "email", "phone"]
        : ["name", "company", "stand", "email", "phone"],
    promise: "by the next working day",
  };
}

export const STARTER_EXAMPLES = {
  exhibitors: [
    "When can we start building?",
    "How do deliveries work?",
    "How many badges do we get?",
  ],
  visitors: ["When is the show?", "Where is the venue?", "What time does it open?"],
} as const;

export function suggestedWelcome(b: {
  name: string;
  audience: "visitors" | "exhibitors";
  showName: string;
}): string {
  const verb = b.audience === "visitors" ? "visiting" : "exhibiting at";
  return `Hi, I'm ${b.name || "your assistant"}. Ask me anything about ${verb} ${b.showName || "the show"}.`;
}

/** Longest "in your own words" personality, and email sign-off, a bot can have. */
export const PERSONALITY_MAX = 600;
export const SIGN_OFF_MAX = 300;

/** Ideas for the personality box (the placeholder and the "Use an example" button). */
export const PERSONALITY_EXAMPLES = {
  exhibitors:
    "Calm and practical, like an experienced ops manager on build-up day. Gets to the point, gives the deadline or rule first, and says where to find more.",
  visitors:
    "Upbeat and welcoming, like a good front-of-house host. Keeps things simple and makes people look forward to the show.",
} as const;

/** Exhibitor answers default to the thorough model (rules, deadlines, money); visitor answers to fast. */
export function defaultQuality(audience: "visitors" | "exhibitors"): "fast" | "thorough" {
  return audience === "exhibitors" ? "thorough" : "fast";
}
