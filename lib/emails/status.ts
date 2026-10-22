/** How each email status reads on screen (shared by server and client components). */
export type EmailStatus =
  "new" | "working" | "draft_ready" | "needs_you" | "sent" | "dismissed" | "failed";

export const EMAIL_STATUS: Record<
  EmailStatus,
  { label: string; tone: "warn" | "good" | "info" | "neutral" | "bad" }
> = {
  new: { label: "Writing…", tone: "info" },
  working: { label: "Writing…", tone: "info" },
  draft_ready: { label: "Draft ready", tone: "good" },
  needs_you: { label: "Needs you", tone: "warn" },
  failed: { label: "Couldn't draft", tone: "bad" },
  sent: { label: "Sent", tone: "neutral" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};
