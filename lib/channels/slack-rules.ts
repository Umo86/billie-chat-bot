import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack, the pure parts (lib/channels/slack.ts talks to Slack). Slack signs
 * every request it sends Billie with the app's signing secret: an HMAC of
 * "v0:<timestamp>:<body>", refused if it's more than five minutes old so an
 * old request can't be sent again.
 */

const MAX_AGE_SECONDS = 5 * 60;

export function verifySlackSignature(
  raw: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !signature || !secret || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_AGE_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A Slack channel id ("C0…" public, "G0…" private), as Slack gives them. */
export const CHANNEL_ID = /^[CG][A-Z0-9]{6,20}$/;

/**
 * A team member's Slack message, as the visitor should see it: mentions and
 * channel links taken out, links written out, Slack's escaping undone.
 */
export function slackToPlain(text: string): string {
  return text
    .replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, "")
    .replace(/<!(?:here|channel|everyone)(?:\|[^>]*)?>/g, "")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>/g, "")
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<#[CG][A-Z0-9]+>/g, "")
    .replace(/<mailto:([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<((?:https?:\/\/)[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/<((?:https?:\/\/)[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** A message in the thread just for the team: "note: …" (or "// …"). */
export function isTeamNote(text: string): boolean {
  return /^\s*(?:note\s*:|\/\/)/i.test(text);
}

/** Text Slack shows exactly as written: no formatting, links or mentions. */
export function plain(text: string, max = 3000) {
  const t = text.trim() || " ";
  return {
    type: "plain_text" as const,
    text: t.length > max ? `${t.slice(0, max - 1)}…` : t,
    emoji: false,
  };
}

/** Escaped for Slack's own markup, for the few places Billie needs it (mentions). */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type SlackBlock = Record<string, unknown>;

export const block = {
  header: (text: string): SlackBlock => ({ type: "header", text: plain(text, 150) }),
  line: (text: string): SlackBlock => ({ type: "section", text: plain(text) }),
  /** A line with an "Open" button beside it (a link that's Billie's own, never the text). */
  linked: (text: string, url: string, label = "Open"): SlackBlock => ({
    type: "section",
    text: plain(text),
    accessory: { type: "button", text: plain(label, 75), url: url.slice(0, 3000) },
  }),
  note: (text: string): SlackBlock => ({ type: "context", elements: [plain(text)] }),
  /** Slack user ids to @mention (Billie's own markup: ids only). */
  mention: (ids: string[], after = ""): SlackBlock => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `${ids.map((id) => (id === "here" ? "<!here>" : `<@${id}>`)).join(" ")}${after ? ` ${escapeMrkdwn(after)}` : ""}`,
    },
  }),
  buttons: (
    items: (
      | { text: string; url: string }
      | { text: string; actionId: string; value: string; style?: "primary" | "danger" }
    )[],
  ): SlackBlock => ({
    type: "actions",
    elements: items.slice(0, 25).map((b, i) =>
      "url" in b
        ? { type: "button", action_id: `billie_link_${i}`, text: plain(b.text, 75), url: b.url }
        : {
            type: "button",
            action_id: b.actionId,
            text: plain(b.text, 75),
            value: b.value,
            ...(b.style ? { style: b.style } : {}),
          },
    ),
  }),
  divider: (): SlackBlock => ({ type: "divider" }),
};

type Card = { body?: unknown[]; actions?: unknown[]; msteams?: { entities?: unknown[] } };

const textOf = (item: Record<string, unknown>): string => {
  if (item.type === "RichTextBlock")
    return ((item.inlines as { text?: string }[] | undefined) ?? [])
      .map((i) => i.text ?? "")
      .join("");
  if (item.type === "TextBlock") return String(item.text ?? "").replace(/<at>([^<]*)<\/at>/g, "$1");
  return "";
};

const isTitle = (item: Record<string, unknown>) =>
  item.type === "RichTextBlock" &&
  ((item.inlines as { weight?: string; size?: string }[] | undefined) ?? []).some(
    (i) => i.weight === "Bolder" && i.size === "Medium",
  );

/**
 * A Teams card (the posts Billie already writes for Teams) as Slack blocks:
 * the title as a header, every line as plain text, a clickable line as a
 * line with an "Open" button, the card's links as buttons. Who it mentions
 * (by email) is returned for the caller to look up in Slack.
 */
export function slackFromCard(card: unknown): {
  text: string;
  blocks: SlackBlock[];
  mentionEmails: string[];
} {
  const c = (card ?? {}) as Card;
  const blocks: SlackBlock[] = [];
  let title = "";
  const walk = (items: unknown[] | undefined) => {
    for (const raw of items ?? []) {
      const item = raw as Record<string, unknown>;
      if (item.type === "Container") {
        const select = item.selectAction as { type?: string; url?: string } | undefined;
        const inner = ((item.items as unknown[]) ?? []).map((i) =>
          textOf(i as Record<string, unknown>),
        );
        const text = inner.filter(Boolean).join("\n");
        if (select?.type === "Action.OpenUrl" && select.url && text)
          blocks.push(block.linked(text, select.url));
        else walk(item.items as unknown[]);
        continue;
      }
      const text = textOf(item);
      if (!text.trim()) continue;
      if (isTitle(item) && !title) {
        title = text;
        blocks.push(block.header(text));
      } else blocks.push(block.line(text));
    }
  };
  walk(c.body);
  // Slack takes at most 50 blocks a message: long posts end with a pointer to the rest.
  if (blocks.length > 48) blocks.splice(47, blocks.length, block.line("…and more in Billie."));
  const links = (c.actions ?? [])
    .map((a) => a as { type?: string; title?: string; url?: string })
    .filter((a) => a.type === "Action.OpenUrl" && a.url && a.title)
    .map((a) => ({ text: a.title!, url: a.url! }));
  if (links.length) blocks.push(block.buttons(links));
  const mentionEmails = (c.msteams?.entities ?? [])
    .map((e) => (e as { type?: string; mentioned?: { id?: string } }).mentioned?.id ?? "")
    .filter((id) => id.includes("@"));
  return {
    text: title || textOf((c.body?.[0] ?? {}) as Record<string, unknown>) || "Billie",
    blocks,
    mentionEmails,
  };
}
