/**
 * The Teams post for a new email in an event mailbox (pure; tested in
 * tests/unit/mailbox-rules.test.ts): who wrote, what they want, whether a
 * reply is waiting in Drafts, and an @mention of the person who manages the
 * mailbox.
 */
import { adaptiveMessage, mentionName, plainLine } from "@/lib/alerts/card";

export type EmailPost = {
  botName: string;
  mailbox: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  summary: string;
  /**
   * draft: the reply is in Drafts. holding: Billie wasn't sure, so a holding
   * reply is in Drafts. needs_you: no draft (a topic that always goes to a person).
   */
  outcome: "draft" | "holding" | "needs_you";
  reason: string | null;
  urgent: boolean;
  assignee: { name: string; email: string } | null;
  link: string;
};

export function emailPostLines(p: EmailPost): { title: string; lines: string[] } {
  const title =
    p.outcome === "draft"
      ? `${p.botName}: a reply is waiting in Drafts`
      : `${p.botName}: an email needs a person`;
  const from = p.fromName ? `${p.fromName} (${p.fromEmail})` : p.fromEmail;
  const lines = [
    `From: ${from}`,
    `Subject: ${p.subject || "(no subject)"}`,
    ...(p.summary ? [`They want: ${p.summary}`] : []),
    ...(p.urgent ? ["Billie thinks this is urgent."] : []),
    ...(p.outcome === "draft"
      ? [`Billie's reply is in Drafts in ${p.mailbox}. Check it, then send it from Outlook.`]
      : p.outcome === "holding"
        ? [
            p.reason ?? "Billie wasn't sure of the answer.",
            `A holding reply is in Drafts in ${p.mailbox}. Check it, or write your own.`,
          ]
        : [p.reason ?? "This needs a person.", `There's no draft. Reply from ${p.mailbox}.`]),
  ];
  return { title, lines };
}

/** A Teams Workflows Adaptive Card; the mention pings the mailbox manager. */
export function emailTeamsCard(p: EmailPost) {
  const { title, lines } = emailPostLines(p);
  const mention = p.assignee ? `<at>${mentionName(p.assignee.name)}</at>` : null;
  return adaptiveMessage({
    body: [
      plainLine(title, { bold: true, size: "Medium", spacing: "None" }),
      ...lines.map((text) => plainLine(text)),
      // A TextBlock, not a TextRun: Teams only turns <at> into a mention there.
      ...(mention
        ? [{ type: "TextBlock", text: `For ${mention}`, wrap: true, spacing: "Medium" }]
        : []),
    ],
    actions: [{ type: "Action.OpenUrl", title: "Open in Billie", url: p.link }],
    ...(p.assignee && mention
      ? {
          msteams: {
            entities: [
              {
                type: "mention",
                text: mention,
                mentioned: { id: p.assignee.email, name: mentionName(p.assignee.name) },
              },
            ],
          },
        }
      : {}),
  });
}
