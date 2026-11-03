/**
 * Which questions can get an earlier answer again (pure; lib/ai/reuse.ts
 * does the storing). Only the question as typed matters, tidied so that
 * "Hi, when does build-up start?" and "when does build up start" match.
 */

const GREETING =
  /^(hi|hello|hey|hiya|good morning|good afternoon|good evening|morning|afternoon)( there| all| billie)?\s+/;
const THANKS = /\s+(please|pls|thanks|thank you|thank you very much|thx|cheers)$/;

/** Lower case, no punctuation, no greeting or thanks around the question. */
export function tidyQuestion(q: string): string {
  let s = q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 2; i++)
    s = s
      .replace(GREETING, "")
      .replace(THANKS, "")
      .replace(/^please\s+/, "");
  return s.trim();
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
const LONG_NUMBER = /\d[\d\s-]{6,}\d/;

/**
 * Worth keeping for others to get the same answer? Not when it holds
 * someone's details (an email address, a phone or order number), and not
 * when it's too short or too long to be a usual question.
 */
export function reusableQuestion(q: string): boolean {
  if (EMAIL.test(q) || LONG_NUMBER.test(q)) return false;
  const t = tidyQuestion(q);
  return t.length >= 6 && t.length <= 300;
}
