import "server-only";
import { emailConfigured } from "@/lib/config";

/**
 * Sending email through Resend (handover alerts, replies to people who left
 * their details, the weekly summary). Retries with backoff; returns false
 * when email isn't set up, so callers can tell staff to send it themselves.
 */
export type OutgoingEmail = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
};

export class EmailNotConfigured extends Error {
  constructor() {
    super("Email isn't set up (RESEND_API_KEY and EMAIL_FROM)");
    this.name = "EmailNotConfigured";
  }
}

export async function sendEmail(email: OutgoingEmail): Promise<void> {
  if (!emailConfigured()) throw new EmailNotConfigured();
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await resend.emails.send({
        from: process.env.EMAIL_FROM!,
        to: email.to,
        subject: email.subject,
        text: email.text,
        ...(email.html ? { html: email.html } : {}),
        ...(email.replyTo ? { replyTo: email.replyTo } : {}),
      });
      if (!error) return;
      last = error.message;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  throw new Error(`Email not sent: ${last}`);
}

/** Minimal HTML for plain-text emails: escaped, paragraphs kept. */
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
