/**
 * Building blocks for Teams posts (pure). Teams reads Markdown in an
 * Adaptive Card's TextBlock, so anything a visitor or an email sender wrote
 * goes in a RichTextBlock's TextRun instead, which Teams shows exactly as
 * written: nobody can slip a link into the team's channel.
 */
export function plainLine(
  text: string,
  opts: { bold?: boolean; size?: "Medium"; spacing?: "None" | "Small" | "Medium" } = {},
) {
  return {
    type: "RichTextBlock",
    spacing: opts.spacing ?? "Small",
    inlines: [
      {
        type: "TextRun",
        text,
        ...(opts.bold ? { weight: "Bolder" } : {}),
        ...(opts.size ? { size: opts.size } : {}),
      },
    ],
  };
}

/** A name safe to put inside Teams' <at>…</at> mention. */
export function mentionName(name: string): string {
  return (
    name
      .replace(/[<>[\]()*_`\\#|~]/g, "")
      .trim()
      .slice(0, 80) || "the mailbox manager"
  );
}

/** The message a Teams Workflows link expects: one Adaptive Card. */
export function adaptiveMessage(card: {
  body: unknown[];
  actions?: unknown[];
  msteams?: Record<string, unknown>;
}) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          ...card,
        },
      },
    ],
  };
}
