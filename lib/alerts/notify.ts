import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, conversations } from "@/lib/db/schema";
import { appUrl, emailConfigured } from "@/lib/config";
import { getSettings } from "@/lib/settings";
import { REASON_LABEL, type HandoverReason } from "@/lib/conversations/handover";
import type { ContactDetails } from "@/lib/types";
import { sendEmail } from "@/lib/email/send";
import { postToTeams, teamsLinkFor } from "@/lib/channels/teams";
import { adaptiveMessage, plainLine } from "./card";

/**
 * Telling the team a chat needs them: a message in the bot's Teams channel
 * (or the company-wide one), through a Teams Workflows link, and an email to
 * the alert addresses. Each is optional; the Inbox shows the chat either
 * way, and its browser alert fires while it's open. A transient failure
 * throws, so the job retries.
 */
export type HandoverAlert = {
  kind: "live" | "ticket";
  botName: string;
  question: string;
  reason: string;
  contact: ContactDetails;
  link: string;
};

export function alertText(a: HandoverAlert): { title: string; lines: string[] } {
  const title =
    a.kind === "live"
      ? `${a.botName}: someone is waiting for a person`
      : `${a.botName}: a question needs a reply`;
  const who = [a.contact.name, a.contact.company, a.contact.stand && `stand ${a.contact.stand}`]
    .filter(Boolean)
    .join(", ");
  const lines = [
    `Question: ${a.question || "(not given)"}`,
    `Why: ${a.reason}`,
    ...(who ? [`From: ${who}`] : []),
    a.kind === "live"
      ? "Answer it now in the Inbox."
      : "Reply from the Inbox; it goes back by email.",
  ];
  return { title, lines };
}

/**
 * A Teams Workflows ("Post to a channel when a webhook request is received")
 * Adaptive Card. The visitor's words go in plain text runs, never Markdown.
 */
export function teamsCard(a: HandoverAlert) {
  const { title, lines } = alertText(a);
  return adaptiveMessage({
    body: [
      plainLine(title, { bold: true, size: "Medium", spacing: "None" }),
      ...lines.map((text) => plainLine(text)),
    ],
    actions: [{ type: "Action.OpenUrl", title: "Open the Inbox", url: a.link }],
  });
}

export async function notifyHandover(
  conversationId: string,
  kind: "live" | "ticket",
): Promise<void> {
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conv) return;
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, conv.botId) });
  const alert: HandoverAlert = {
    kind,
    botName: bot?.name ?? "Billie",
    question: conv.firstQuestion,
    reason: conv.handoverReason
      ? REASON_LABEL[conv.handoverReason as HandoverReason]
      : "Needs a person",
    contact: conv.contact as ContactDetails,
    link: `${appUrl()}/inbox?c=${conv.id}`,
  };

  const failures: string[] = [];
  // The event's own Teams channel when the bot has one, else the company-wide one.
  const teams = teamsLinkFor(bot?.teamsWebhookUrl);
  if (teams) {
    await postToTeams(teams, teamsCard(alert)).catch((err) =>
      failures.push(err instanceof Error ? err.message : String(err)),
    );
  }
  const settings = await getSettings();
  const to = settings.alertEmails
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.includes("@"));
  if (emailConfigured() && to.length) {
    const { title, lines } = alertText(alert);
    await sendEmail({ to, subject: title, text: `${lines.join("\n")}\n\n${alert.link}` }).catch(
      (err) => failures.push(err instanceof Error ? err.message : String(err)),
    );
  }
  if (failures.length) throw new Error(failures.join("; "));
}
