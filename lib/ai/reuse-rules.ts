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
/** Letters, digits, spaces and everyday punctuation: nothing else. */
const PLAIN = /^[\p{L}\p{N}\s'’‘`"“”?!.,:;()&/£$€%+-]*$/u;
const MARKS = /[^\p{L}\p{N}\s]/gu;

/**
 * Worth keeping for others to get the same answer? Not when it holds
 * someone's details (an email address, a phone or order number), and not
 * when it's too short or too long to be a usual question. And only plain
 * text: the key ignores case and punctuation, so anything that could carry
 * words the key doesn't see (emoji, symbols, invisible or combining
 * characters, a lot of punctuation) would let one person's wording, which
 * Claude reads in full, decide the answer everyone else gets.
 */
export function reusableQuestion(q: string): boolean {
  const n = q.normalize("NFKC");
  if (!PLAIN.test(n) || (n.match(MARKS)?.length ?? 0) > 8) return false;
  if (EMAIL.test(q) || LONG_NUMBER.test(q)) return false;
  const t = tidyQuestion(q);
  return t.length >= 6 && t.length <= 300;
}

const URL_LIKE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>()"'`]*)?/gi;
const EMAIL_ALL = /[^\s@<>()"'`,;:]+@[^\s@<>()"'`,;:]+\.[a-z]{2,}/gi;
const PHONE = /\+?\d[\d\s()-]{5,}\d/g;

const bare = (s: string) =>
  s
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/(^|[^a-z0-9.-])www\./g, "$1")
    .replace(/[.,;:!?)\]]+$/, "");

/**
 * Every web address, email address and phone number in an answer is in the
 * passages it came from. An answer given again to everyone mustn't point
 * anyone somewhere the knowledge doesn't.
 */
export function linksGrounded(answer: string, passages: string[]): boolean {
  const text = bare(passages.join("\n"));
  const digits = passages.join(" ").replace(/\D+/g, "");
  for (const m of answer.match(EMAIL_ALL) ?? []) if (!text.includes(bare(m))) return false;
  const withoutEmails = answer.replace(EMAIL_ALL, " ");
  for (const m of withoutEmails.match(URL_LIKE) ?? []) if (!text.includes(bare(m))) return false;
  for (const m of answer.match(PHONE) ?? []) {
    const d = m.replace(/\D+/g, "");
    if (d.length >= 7 && !digits.includes(d)) return false;
  }
  return true;
}
