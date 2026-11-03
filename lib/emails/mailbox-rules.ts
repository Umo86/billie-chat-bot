/**
 * Rules for a bot's event mailbox and Teams channel (pure; tested in
 * tests/unit/mailbox-rules.test.ts).
 */
import { EMAIL_PATTERN } from "@/lib/auth/config";

/** The mailbox address as stored: trimmed and lower case; null when it isn't an email address. */
export function normaliseMailbox(address: string): string | null {
  const a = address.trim().toLowerCase();
  return a.length <= 254 && EMAIL_PATTERN.test(a) ? a : null;
}

/**
 * Teams posts go to a Teams Workflows link ("Post to a channel when a
 * webhook request is received"), or an older channel connector. Only
 * Microsoft's own hosts are accepted, so the link can't point Billie's
 * server anywhere else.
 */
const TEAMS_HOSTS = [".logic.azure.com", ".api.powerplatform.com", ".webhook.office.com"];

export function teamsLinkProblem(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return "Paste the whole link from Teams, starting with https://";
  }
  if (url.protocol !== "https:") return "The Teams link must start with https://";
  if (url.username || url.password) return "That doesn't look like a Teams link.";
  const host = url.hostname.toLowerCase();
  if (!TEAMS_HOSTS.some((h) => host.endsWith(h)))
    return "That isn't a Teams Workflows link. In the channel, use ••• → Workflows → Post to a channel when a webhook request is received, and copy the link it gives you.";
  return null;
}

/** What the screen shows for a saved link: the host only, never the secret part. */
export function teamsLinkLabel(link: string | null): string | null {
  if (!link) return null;
  try {
    return new URL(link).hostname;
  } catch {
    return "saved";
  }
}

/**
 * Emails Billie leaves alone: auto-replies, bounces, read receipts, meeting
 * replies, and mail the mailbox sent itself. Drafting replies to those would
 * fill Drafts and Teams after every mailshot.
 */
const AUTO_SENDER =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)([+._-][^@]*)?@/i;
const AUTO_SUBJECT =
  /^\s*(automatic reply|auto(matic)?[- ]?(reply|response)|auto:|out of (the )?office|undeliverable|undelivered mail|delivery status notification|delivery has failed|mail delivery (failed|failure|system)|returned mail|read:|not read:|accepted:|declined:|tentative:|tentatively accepted:|cancell?ed:|new time proposed:)/i;

export function skipIncoming(m: { from: string; subject: string; mailbox: string }): boolean {
  const from = m.from.trim().toLowerCase();
  if (!from || from === m.mailbox) return true;
  return AUTO_SENDER.test(from) || AUTO_SUBJECT.test(m.subject);
}

/**
 * Billie's reply as HTML for the top of the Outlook draft. Outlook drafts
 * are HTML, where plain line breaks collapse, so every line break is kept
 * as <br>. A font is set because Outlook shows unstyled text in Times.
 */
export function replyHtml(text: string): string {
  const escaped = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
  return `<div style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:11pt">${escaped}</div><br>`;
}

/** Puts the reply at the top of the draft's body, above the quoted email. */
export function spliceReply(draftHtml: string, reply: string): string {
  const open = /<body[^>]*>/i.exec(draftHtml);
  if (!open) return reply + draftHtml;
  const at = open.index + open[0].length;
  return draftHtml.slice(0, at) + reply + draftHtml.slice(at);
}

/** Billie's categories replace its earlier ones ("Billie: …"); the team's own stay. */
export function withBillieCategories(current: string[], ours: string[]): string[] {
  const kept = current.filter((c) => !c.startsWith("Billie: "));
  return [...new Set([...kept, ...ours.filter(Boolean)])].slice(0, 25);
}

/** A Microsoft Graph call that failed: its HTTP status and Graph's error code. */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

/** Billie couldn't get a Microsoft 365 token (wrong or expired settings). */
export class MicrosoftSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrosoftSignInError";
  }
}

/** The mailbox's sync point has expired: start again from the last two days. */
export function syncWasReset(err: unknown): boolean {
  return err instanceof GraphError && (err.status === 410 || /syncstate|resync/i.test(err.code));
}

/**
 * A failure saving a draft that trying again won't fix: no write access
 * (403), the email is gone from the mailbox (404), or Graph refused the
 * request (400). Timeouts, throttling and Microsoft's own errors are retried.
 */
export function draftFailureIsFinal(err: unknown): boolean {
  return err instanceof GraphError && [400, 403, 404, 410].includes(err.status);
}

/** Why a reply couldn't be saved in Drafts, in words for the screen. */
export function draftProblem(err: unknown): string {
  if (err instanceof GraphError && (err.status === 401 || err.status === 403))
    return 'Billie can read this mailbox but isn\'t allowed to save drafts in it. Ask IT to give Billie the "Application Mail.ReadWrite" role for it.';
  if (err instanceof GraphError && (err.status === 404 || err.status === 410))
    return "The email was moved or deleted in Outlook before Billie could reply to it.";
  return mailboxProblem(err);
}

/** What went wrong with a mailbox, in words for the screen. */
export function mailboxProblem(err: unknown): string {
  if (err instanceof MicrosoftSignInError)
    return "Billie couldn't sign in to Microsoft 365. Check MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET in Vercel. The client secret may have expired.";
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return "Microsoft 365 didn't answer in time. Billie tries again every minute.";
  if (!(err instanceof GraphError))
    return "Billie couldn't reach this mailbox. It tries again every minute.";
  const code = err.code.toLowerCase();
  if (err.status === 401 || err.status === 403 || code.includes("accessdenied"))
    return "Billie isn't allowed into this mailbox yet. Ask IT to add it to the mailboxes Billie may use (Settings → Connections has the steps).";
  if (
    err.status === 404 ||
    [
      "errorinvaliduser",
      "resourcenotfound",
      "mailboxnotenabledforrestapi",
      "errorinvalidmailbox",
    ].includes(code)
  )
    return "Microsoft 365 can't find this mailbox. Check the address, and that it's a mailbox in Exchange Online.";
  if (err.status === 429)
    return "Microsoft 365 asked Billie to slow down. It tries again in a minute.";
  if (err.status >= 500) return "Microsoft 365 had a problem. Billie tries again every minute.";
  return "Microsoft 365 turned the request down. Billie tries again every minute.";
}
