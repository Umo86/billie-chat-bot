/**
 * Learning from an event mailbox's past emails (pure; lib/emails/history.ts
 * does the reading). Each reply the team sent is paired with the email it
 * answered (the latest one in the same thread from someone else, before the
 * reply); Claude then finds the questions that come up, in general words,
 * with the team's answers; and the same question found in different batches
 * is counted together.
 */

import { questionKey } from "@/lib/knowledge/gaps";

export type PastMessage = {
  conversationId: string;
  from: string;
  at: string;
  subject: string;
  /** Only this message's own words (Outlook's uniqueBody), not the quoted thread. */
  text: string;
};

export type Pair = { subject: string; asked: string; replied: string };

/** Most emails and replies read from one mailbox. */
export const MAX_REPLIES = 300;
export const MAX_INBOUND = 1500;
/** Emails per Claude call. */
export const BATCH = 15;
const MAX_TEXT = 1500;

const AUTOMATIC =
  /^(auto(matic)? ?reply|out of (the )?office|undeliverable|delivery status notification|mail delivery (failed|subsystem))/i;
const NOREPLY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster)@/i;

/** Whitespace tidied and cut; signatures and quoted lines left out where they're marked. */
export function cleanText(text: string): string {
  const lines: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    // Where the quoted thread or a signature starts, if Outlook left any.
    if (/^(-{2,}|_{5,}|from:\s|sent from my|on .+ wrote:$)/i.test(line)) break;
    if (line.startsWith(">")) continue;
    lines.push(line);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);
}

/** Each reply with the email it answered, newest first, at most `max`. */
export function buildPairs(
  sent: PastMessage[],
  inbound: PastMessage[],
  mailbox: string,
  max = MAX_REPLIES,
): Pair[] {
  const me = mailbox.toLowerCase();
  const byThread = new Map<string, PastMessage[]>();
  for (const m of inbound) {
    const from = m.from.toLowerCase();
    if (!m.conversationId || !from || from === me || NOREPLY.test(from)) continue;
    if (AUTOMATIC.test(m.subject)) continue;
    const list = byThread.get(m.conversationId) ?? [];
    list.push(m);
    byThread.set(m.conversationId, list);
  }
  const pairs: Pair[] = [];
  const used = new Set<string>();
  for (const r of [...sent].sort((a, b) => b.at.localeCompare(a.at))) {
    const asked = (byThread.get(r.conversationId) ?? [])
      .filter((m) => m.at < r.at)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!asked) continue;
    // One pair per email: a second reply to the same email adds nothing.
    const key = `${asked.conversationId}|${asked.at}`;
    if (used.has(key)) continue;
    const q = cleanText(asked.text);
    const a = cleanText(r.text);
    if (q.length < 10 || a.length < 10) continue;
    used.add(key);
    pairs.push({ subject: asked.subject.slice(0, 200), asked: q, replied: a });
    if (pairs.length >= max) break;
  }
  return pairs;
}

export type Found = { question: string; answer: string; count: number };

/**
 * The same question from different batches counted together (by its
 * wording, as gaps are), with the answer from the batch where it came up
 * most; most asked first.
 */
export function mergeFound(batches: Found[][]): (Found & { key: string })[] {
  const byKey = new Map<string, Found & { key: string; best: number }>();
  for (const batch of batches)
    for (const f of batch) {
      const question = f.question.trim().slice(0, 300);
      const answer = f.answer.trim().slice(0, 2000);
      const key = questionKey(question);
      if (!key || !answer || f.count < 1) continue;
      const had = byKey.get(key);
      if (!had) byKey.set(key, { key, question, answer, count: f.count, best: f.count });
      else {
        had.count += f.count;
        if (f.count > had.best) Object.assign(had, { question, answer, best: f.count });
      }
    }
  return [...byKey.values()]
    .map((f) => ({ key: f.key, question: f.question, answer: f.answer, count: f.count }))
    .sort((a, b) => b.count - a.count || a.question.localeCompare(b.question));
}

/** The ones worth offering: asked more than once (or the top few, if nothing was). */
export function worthOffering<T extends Found>(found: T[], max = 40): T[] {
  const often = found.filter((f) => f.count >= 2);
  return (often.length ? often : found.slice(0, 10)).slice(0, max);
}
