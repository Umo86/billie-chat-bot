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
    hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
    // Outside working hours: visitors leave a number to call back; exhibitors, their stand.
    collect: audience === "visitors" ? ["name", "email", "phone"] : ["name", "email", "stand"],
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

export type BotType = "visitors" | "exhibitors";

/**
 * The two kinds of chatbot. An exhibitor chatbot goes in BluePrint, the
 * exhibitor manual; a visitor chatbot on the event website. The kind decides
 * who the answers are written for, what it asks for outside working hours,
 * and whether it has an exhibitor list (the Exhibitors step).
 */
export const BOT_TYPES: Record<
  BotType,
  { label: string; where: string; about: string; outOfHours: string }
> = {
  exhibitors: {
    label: "Exhibitor chatbot",
    where: "In BluePrint, the exhibitor manual",
    about:
      "Answers exhibitors about build-up, deliveries, badges, stand rules and orders. Exhibitors signed in from BluePrint get answers about their own stand.",
    outOfHours: "Outside working hours it takes their name, email and stand number.",
  },
  visitors: {
    label: "Visitor chatbot",
    where: "On the event website",
    about: "Answers visitors about dates, opening times, travel, tickets and what's on.",
    outOfHours: "Outside working hours it takes their name, email and phone number, to call back.",
  },
};

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * A bot's settings for its new kind: anything still on the old kind's default
 * (what it asks for outside hours, the topics that always go to a person, its
 * answer quality) becomes the new kind's; anything the team chose stays.
 */
export function forNewType(
  from: BotType,
  to: BotType,
  current: { rules: BotRules; quality: "fast" | "thorough" },
): { rules: BotRules; quality: "fast" | "thorough" } {
  if (from === to) return current;
  const was = defaultRules(from);
  const now = defaultRules(to);
  return {
    rules: {
      ...current.rules,
      collect: sameSet(current.rules.collect, was.collect) ? now.collect : current.rules.collect,
      alwaysHuman: sameSet(current.rules.alwaysHuman, was.alwaysHuman)
        ? now.alwaysHuman
        : current.rules.alwaysHuman,
    },
    quality: current.quality === defaultQuality(from) ? defaultQuality(to) : current.quality,
  };
}
