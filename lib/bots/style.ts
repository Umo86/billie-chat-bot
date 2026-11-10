/**
 * How a bot comes across in chat (pure): its tone, answer length, the
 * team's description of its personality, emoji, names and words to avoid,
 * plus ready-made styles to start from. Style only: answers still come only
 * from the bot's knowledge, and its rules always win.
 */

export type Tone = "friendly" | "formal" | "brief";
export type AnswerLength = "short" | "normal" | "detailed";

export type ChatStyle = {
  tone: Tone;
  answerLength: AnswerLength;
  personality: string;
  emoji: boolean;
  useName: boolean;
  avoidWords: string;
};

/** Longest "in your own words" personality, and email sign-off, a bot can have. */
export const PERSONALITY_MAX = 600;
export const SIGN_OFF_MAX = 300;
export const AVOID_MAX = 300;
export const LAUNCHER_LABEL_MAX = 24;

export const TONE_HELP: Record<Tone, string> = {
  friendly: "Warm and chatty, like a helpful person on the show's team.",
  formal: "Polite and professional, still kind. Good for contracts, rules and deadlines.",
  brief: "Friendly but quick: straight to the answer.",
};

export const LENGTH_HELP: Record<AnswerLength, string> = {
  short: "One or two sentences.",
  normal: "Up to four sentences, or a short list.",
  detailed: "Up to six sentences, or a list with a line of context.",
};

/** The words to avoid, one per line or separated by commas or semicolons. */
export function avoidList(words: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of words.split(/[\n,;]+/)) {
    const w = raw
      .trim()
      .replace(/^["“”']+|["“”']+$/g, "")
      .trim();
    const key = w.toLowerCase();
    if (!w || w.length > 60 || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length === 20) break;
  }
  return out;
}

export type StylePreset = {
  id: string;
  label: string;
  /** One line under the label, saying how it sounds. */
  about: string;
  /** A sample reply, to show how it sounds. */
  sample: string;
  style: (audience: "visitors" | "exhibitors") => ChatStyle;
  /** Colours that go with it (header, buttons), offered but never forced. */
  colours?: { color: string; accentColor: string };
};

const BASE = { useName: true, avoidWords: "" } as const;

/** Ready-made chat styles. Picking one fills in the settings; the team can change any of them. */
export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "friendly",
    label: "Friendly",
    about: "Warm, plain and helpful. The best fit for most chats.",
    sample: "Build-up starts at 8am on Sunday 14 March. Just ask if anything else comes up!",
    style: (a) => ({
      ...BASE,
      tone: "friendly",
      answerLength: "normal",
      emoji: false,
      personality:
        a === "visitors"
          ? "Warm and welcoming, like a friendly face on the front desk. Uses everyday words, sounds pleased to help, and makes people look forward to the show."
          : "Warm and helpful, like a friendly colleague in the organiser's team. Uses everyday words, sounds pleased to help, and makes exhibitors feel looked after.",
    }),
  },
  {
    id: "professional",
    label: "Professional",
    about: "Polite and precise, still warm. Good for rules and deadlines.",
    sample:
      "Build-up opens at 8am on Sunday 14 March. Please make sure your contractors have their passes before they arrive.",
    style: (a) => ({
      ...BASE,
      tone: "formal",
      answerLength: "normal",
      emoji: false,
      personality:
        a === "visitors"
          ? "Courteous and professional, like a good hotel concierge. Clear and exact, never stiff."
          : "Courteous and professional, like an experienced operations manager. Clear and exact, never stiff. Gives the rule or deadline first.",
    }),
  },
  {
    id: "calm",
    label: "Calm expert",
    about: "Practical and reassuring, for busy build-up days.",
    sample:
      "No problem, that's easy to sort. Deliveries go to Gate 4 from 8am. Bring your stand number and you'll be waved through.",
    style: () => ({
      ...BASE,
      tone: "friendly",
      answerLength: "normal",
      emoji: false,
      personality:
        "Calm and practical, like an experienced ops manager on build-up day. Reassures people when something's gone wrong, gives the deadline or rule first, and says where to find more.",
    }),
  },
  {
    id: "short",
    label: "Short and sweet",
    about: "Quick, friendly answers with no extra words.",
    sample: "8am on Sunday 14 March.",
    style: () => ({
      ...BASE,
      tone: "brief",
      answerLength: "short",
      emoji: false,
      personality: "Friendly but quick. Gives the answer straight away, with no extra words.",
    }),
  },
  {
    id: "upbeat",
    label: "Upbeat",
    about: "Lively and fun, with the odd emoji.",
    sample: "Love that you're coming! 🎉 Doors open at 10am on Tuesday. See you there!",
    style: (a) => ({
      ...BASE,
      tone: "friendly",
      answerLength: "normal",
      emoji: true,
      personality:
        a === "visitors"
          ? "Upbeat and enthusiastic, like a great event host. Excited about the show, keeps things light and fun, and gets people looking forward to their visit."
          : "Upbeat and positive, like a great event host. Keeps things light and encouraging, and gets exhibitors excited about a great show.",
    }),
  },
  {
    id: "christmas",
    label: "Christmas (Santa)",
    about: "Writes like Santa: jolly and festive. Facts stay exact.",
    sample:
      "Ho ho ho! The elves tell me build-up starts at 8am on Sunday 14 March. Merry building!",
    colours: { color: "#b3121b", accentColor: "#146b3a" },
    style: () => ({
      ...BASE,
      tone: "friendly",
      answerLength: "normal",
      emoji: true,
      personality:
        'Writes like Santa: jolly, warm and festive. Opens a chat with a cheerful "Ho ho ho!" (not every message), and now and then mentions the elves, the sleigh or the North Pole. Dates, times, prices and rules are always given plainly and exactly, never as a joke.',
    }),
  },
];

/** The preset these settings came from, if they still match one exactly. */
export function matchingPreset(
  s: ChatStyle,
  audience: "visitors" | "exhibitors",
): StylePreset | null {
  return (
    STYLE_PRESETS.find((p) => {
      const q = p.style(audience);
      return (
        q.tone === s.tone &&
        q.answerLength === s.answerLength &&
        q.emoji === s.emoji &&
        q.personality === s.personality.trim()
      );
    }) ?? null
  );
}
