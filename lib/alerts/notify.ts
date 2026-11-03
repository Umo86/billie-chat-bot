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
import { availablePeople, cardOf, eventManager, queueDirect } from "./direct";
import { assignByRoute, routeFor, visitorWords } from "@/lib/conversations/routing";

/**
 * Telling the team a chat needs them: a Teams message to each person who
 * should answer (whoever is available, else the event's mailbox manager), a
 * post in the bot's Teams channel (or the company-wide one), and an email
 * to the alert addresses. Each is optional; the Inbox shows the chat either
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
  /** Who handles its topic (the bot's "who handles what"), if a rule matched. */
  routed?: { topic: string; name: string } | null;
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
    ...(a.routed ? [`About: ${a.routed.topic}, which ${a.routed.name} handles`] : []),
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
  // Who handles its topic goes first, and has the chat if nobody else does yet.
  const routed = await routeFor(conv.botId, [conv.firstQuestion, ...(await visitorWords(conv.id))]);
  if (routed) await assignByRoute(conv.id, routed);
  const alert: HandoverAlert = {
    kind,
    routed: routed && { topic: routed.topic, name: routed.name },
    botName: bot?.name ?? "Billie",
    question: conv.firstQuestion,
    reason: conv.handoverReason
      ? REASON_LABEL[conv.handoverReason as HandoverReason]
      : "Needs a person",
    contact: conv.contact as ContactDetails,
    link: `${appUrl()}/inbox?c=${conv.id}`,
  };

  // First, Teams messages to people (queued once, so a retry of this job never repeats them):
  // whoever is available for live chats, or, when nobody is, whoever manages the event's mailbox.
  // With a person for the topic: them, and for a live chat whoever is available too
  // when they aren't.
  const available = kind === "live" ? await availablePeople(conv.botId) : [];
  const people = routed
    ? [
        { email: routed.email },
        ...(available.some((p) => p.email === routed.email) ? [] : available),
      ]
    : kind === "live"
      ? available
      : await eventManager(conv.botId);
  await queueDirect(
    people,
    `chat:${conv.id}:${conv.handoverAt?.getTime() ?? 0}`,
    cardOf(teamsCard(alert)),
  );

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
