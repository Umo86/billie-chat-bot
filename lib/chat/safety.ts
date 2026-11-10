/**
 * Suspicious chats (pure): when Billie judges a message to be a trick, abuse
 * or fraud (lib/ai/prompts.ts, SAFETY), it doesn't answer it. It points the
 * person to the event team's email instead, and after two such messages it
 * stops answering that chat altogether, without asking Claude again.
 */

/** Suspicious messages in one chat before Billie stops answering it. */
export const SUSPICIOUS_LIMIT = 2;

const team = (email: string) =>
  email.trim() ? `please email the event team at ${email.trim()}` : "please contact the event team";

/** The reply to a suspicious message. */
export function suspiciousLine(email: string): string {
  return `Sorry, I can't help with that here. If you need something from us, ${team(email)}.`;
}

/** What a chat says once Billie has stopped answering it. */
export function stoppedLine(email: string): string {
  return `I can't help any further in this chat. If you need something from us, ${team(email)}.`;
}
