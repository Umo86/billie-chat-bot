import "server-only";
import { and, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, conversations, slackThreads } from "@/lib/db/schema";
import { appUrl, emailConfigured } from "@/lib/config";
import { getSettings } from "@/lib/settings";
import { REASON_LABEL, type HandoverReason } from "@/lib/conversations/handover";
import type { ContactDetails } from "@/lib/types";
import { sendEmail } from "@/lib/email/send";
import { enqueue } from "@/lib/jobs/queue";
import { safeError } from "@/lib/errors";
import { slackRetryable } from "@/lib/channels/slack";
import { postToTeams, teamsLinkFor } from "@/lib/channels/teams";
import { adaptiveMessage, plainLine } from "./card";
import { availablePeople, cardOf, eventManager, queueDirect } from "./direct";
import { assignByRoute, routeFor, visitorWords } from "@/lib/conversations/routing";
import { postHandoverToSlack } from "./slack-chat";
import { slackPeopleFor } from "@/lib/bots/slack-people";

/**
 * Telling the team a chat needs them: once Slack is connected, a post in the
 * event's Slack channel, answered in its thread (lib/alerts/slack-chat.ts);
 * otherwise a Teams message to each person who should answer (whoever is
 * available, else the event's mailbox manager) and a post in the bot's Teams
 * channel (or the company-wide one). Either way, an email to the alert
 * addresses. Each is optional, and one failing never stops the others; the
 * Inbox shows the chat either way, and its browser alert fires while it's
 * open. A transient failure throws, so the job retries.
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

/**
 * Has this handover already been posted in Slack (a retry of the job)? For a
 * live chat, any post since it was handed over counts: it may be a ticket by
 * now, posted in the same thread. For a ticket, only the ticket's own.
 */
async function alreadyInSlack(
  conversationId: string,
  kind: "live" | "ticket",
  since: Date | null,
): Promise<boolean> {
  if (!since) return false;
  const rows = await db
    .select({ kind: slackThreads.kind })
    .from(slackThreads)
    .where(
      and(eq(slackThreads.conversationId, conversationId), gte(slackThreads.createdAt, since)),
    );
  return kind === "live" ? rows.length > 0 : rows.some((r) => r.kind === "ticket");
}

/** What the team is told about a chat, and who handles its topic. */
async function alertFor(conv: typeof conversations.$inferSelect, kind: "live" | "ticket") {
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, conv.botId) });
  const routed = await routeFor(conv.botId, [conv.firstQuestion, ...(await visitorWords(conv.id))]);
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
  return { bot, routed, alert };
}

const alertTo = async () =>
  (await getSettings()).alertEmails
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.includes("@"));

/** Is the chat still where this job left it? A late retry tells nobody about a chat that's moved on. */
const stillNeeds = (status: string, kind: "live" | "ticket") =>
  status === (kind === "live" ? "waiting" : "ticket");

export async function notifyHandover(
  conversationId: string,
  kind: "live" | "ticket",
): Promise<void> {
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conv || !stillNeeds(conv.status, kind)) return;
  const { bot, routed, alert } = await alertFor(conv, kind);
  // Who handles its topic goes first, and has the chat if nobody else does yet.
  if (routed) await assignByRoute(conv.id, routed);

  // Slack, once it's connected: the chat in the event's channel, answered in its thread.
  // A retry finds it already posted, so it never posts twice. When Slack can't take it,
  // the people below still hear, and the alert email goes: a failure in one never
  // stops the others. Slack being busy is tried again; Billie not in the channel isn't.
  let slack = false;
  let slackFailed = false;
  let retry: unknown = null;
  if (await alreadyInSlack(conv.id, kind, conv.handoverAt)) slack = true;
  else {
    try {
      slack = await postHandoverToSlack(conv.id, conv.botId, {
        kind,
        botName: alert.botName,
        question: alert.question,
        reason: alert.reason,
        contact: alert.contact,
        routed: routed && { topic: routed.topic, name: routed.name, email: routed.email },
        alsoEmails:
          kind === "ticket" && !routed ? (await eventManager(conv.botId)).map((p) => p.email) : [],
        team: await slackPeopleFor(conv.botId),
        link: alert.link,
      });
    } catch (err) {
      slackFailed = true;
      console.warn("The chat wasn't posted in Slack:", safeError(err));
      if (slackRetryable(err)) retry = err;
    }
  }

  // Otherwise messages to people (queued once, so a retry of this job never repeats
  // them): whoever is available for live chats, or, when nobody is, whoever manages the
  // event's mailbox. With a person for the topic: them, and for a live chat whoever is
  // available too when they aren't. When Slack failed and nobody is available, the
  // manager hears about a live chat too.
  const available = !slack && kind === "live" ? await availablePeople(conv.botId) : [];
  const people = slack
    ? []
    : routed
      ? [
          { email: routed.email },
          ...(available.some((p) => p.email === routed.email) ? [] : available),
        ]
      : kind === "live" && (available.length || !slackFailed)
        ? available
        : await eventManager(conv.botId);
  await queueDirect(
    people,
    `chat:${conv.id}:${conv.handoverAt?.getTime() ?? 0}`,
    cardOf(teamsCard(alert)),
  );

  const failures: string[] = [];
  // The event's own Teams channel when the bot has one, else the company-wide one.
  const teams = slack ? null : teamsLinkFor(bot?.teamsWebhookUrl);
  if (teams) {
    await postToTeams(teams, teamsCard(alert)).catch((err) =>
      failures.push(err instanceof Error ? err.message : String(err)),
    );
  }
  // The alert email, once for each handover: its own job, so nothing above stops it.
  if (emailConfigured() && (await alertTo()).length)
    await enqueue(
      "alert_email",
      { conversationId: conv.id, kind },
      {
        dedupeKey: `alert-email:${conv.id}:${kind}:${conv.handoverAt?.getTime() ?? 0}`,
        once: true,
      },
    );
  if (failures.length) throw new Error(failures.join("; "));
  if (retry) throw retry;
}

/** The "alert_email" job: the handover, to the alert addresses (Settings → General). */
export async function sendAlertEmail(
  conversationId: string,
  kind: "live" | "ticket",
): Promise<void> {
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  const to = await alertTo();
  if (!conv || !emailConfigured() || !to.length) return;
  const { alert } = await alertFor(conv, kind);
  const { title, lines } = alertText(alert);
  await sendEmail({ to, subject: title, text: `${lines.join("\n")}\n\n${alert.link}` });
}
