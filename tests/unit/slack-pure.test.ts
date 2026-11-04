import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  block,
  isTeamNote,
  mentionsSomeone,
  slackExternalId,
  slackFromCard,
  slackMessageOf,
  slackToPlain,
  ticketReplyLine,
  verifySlackSignature,
} from "@/lib/channels/slack-rules";
import { SlackError, slackRetryable } from "@/lib/channels/slack";
import { slackManifest } from "@/lib/channels/slack-manifest";
import { adaptiveMessage, plainLine } from "@/lib/alerts/card";
import { contactComplete } from "@/lib/conversations/handover";

const sign = (secret: string, ts: number, body: string) =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

describe("Slack requests", () => {
  const now = 1_793_750_000;
  it("takes only requests signed with the app's secret, and only recent ones", () => {
    const body = '{"type":"event_callback"}';
    expect(verifySlackSignature(body, String(now), sign("s3cret", now, body), "s3cret", now)).toBe(
      true,
    );
    // Another secret, a changed body, no signature.
    expect(verifySlackSignature(body, String(now), sign("other", now, body), "s3cret", now)).toBe(
      false,
    );
    expect(
      verifySlackSignature(`${body} `, String(now), sign("s3cret", now, body), "s3cret", now),
    ).toBe(false);
    expect(verifySlackSignature(body, String(now), null, "s3cret", now)).toBe(false);
    expect(verifySlackSignature(body, String(now), sign("", now, body), "", now)).toBe(false);
    // Over five minutes old: someone sending an old request again.
    const old = now - 301;
    expect(verifySlackSignature(body, String(old), sign("s3cret", old, body), "s3cret", now)).toBe(
      false,
    );
    expect(verifySlackSignature(body, "12abc", sign("s3cret", now, body), "s3cret", now)).toBe(
      false,
    );
  });
});

describe("the team's Slack replies, as the visitor sees them", () => {
  it("takes out mentions, writes out links and undoes Slack's escaping", () => {
    expect(
      slackToPlain(
        "<@U123ABC> Hi Sam &amp; team: the form is <https://manual.test/forms|here> &lt;today&gt;. <!here>",
      ),
    ).toBe("Hi Sam & team: the form is here (https://manual.test/forms) <today>.");
    expect(
      slackToPlain("See <https://ukcw.test/travel> or <mailto:ops@m10.test|ops@m10.test>"),
    ).toBe("See https://ukcw.test/travel or ops@m10.test");
    expect(slackToPlain("Ask in <#C0123ABCD|ukcw-ops>")).toBe("Ask in #ukcw-ops");
    expect(slackToPlain("<@U123ABC>")).toBe("");
  });

  it("keeps notes to the team in the thread, however they're written", () => {
    expect(isTeamNote("note: checking with electrics")).toBe(true);
    expect(isTeamNote("Note : not for them")).toBe(true);
    expect(isTeamNote("// internal")).toBe(true);
    expect(isTeamNote("*Note:* he still owes £5k")).toBe(true);
    expect(isTeamNote("_note:_ in italics")).toBe(true);
    expect(isTeamNote("> note: quoted")).toBe(true);
    // As the visitor would get it: a mention in front is taken out first.
    expect(isTeamNote(slackToPlain("<@U123ABC> note: can you check?"))).toBe(true);
    expect(isTeamNote("Your note has been received")).toBe(false);
    expect(isTeamNote("Notes are due on Friday")).toBe(false);
  });

  it("keeps anything said to someone in the team out of the visitor's chat", () => {
    expect(mentionsSomeone("<@U123ABC> can you take this?")).toBe(true);
    expect(mentionsSomeone("Thanks <@W0GRID01>")).toBe(true);
    expect(mentionsSomeone("<!here> anyone free?")).toBe(true);
    expect(mentionsSomeone("<!subteam^S0123ABC|@ops> help")).toBe(true);
    expect(mentionsSomeone("See <#C0123ABCD|ukcw-ops> or <https://manual.test|the manual>")).toBe(
      false,
    );
    expect(mentionsSomeone("Email ops@media10.test")).toBe(false);
  });

  it("knows a reply written in Slack by its message there", () => {
    const id = slackExternalId("C0EVENT001", "1793782476.000100");
    expect(slackMessageOf(id)).toEqual({ channel: "C0EVENT001", ts: "1793782476.000100" });
    expect(slackMessageOf("wamid.HBgLNDQ3NzAwOTAwMTIzFQIAEhgg")).toBeNull();
    expect(slackMessageOf(null)).toBeNull();
  });

  it("says where a reply to a ticket goes", () => {
    expect(ticketReplyLine({ channel: "whatsapp" }, false)).toBe(
      "Reply in this thread: it goes to them on WhatsApp.",
    );
    expect(ticketReplyLine({ channel: "web", email: "sam@acme.test" }, true)).toBe(
      "Reply in this thread: it goes to them by email.",
    );
    expect(ticketReplyLine({ channel: "web", email: "sam@acme.test" }, false)).toMatch(
      /email sending isn't set up/,
    );
    expect(ticketReplyLine({ channel: "web" }, true)).toMatch(/didn't leave an email address/);
  });
});

describe("Slack failures", () => {
  it("tries again when Slack is busy, not when Billie was taken out of the channel", () => {
    for (const code of ["rate_limited", "internal_error", "http_502", "service_unavailable"])
      expect(slackRetryable(new SlackError(code))).toBe(true);
    for (const code of ["not_in_channel", "channel_not_found", "is_archived", "invalid_auth"])
      expect(slackRetryable(new SlackError(code))).toBe(false);
    expect(slackRetryable(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("Billie's posts in Slack", () => {
  it("turns a Teams card into plain-text blocks: nothing anyone wrote becomes markup", () => {
    const card = adaptiveMessage({
      body: [
        plainLine("UKCW Exhibitor Help: last week", { bold: true, size: "Medium" }),
        plainLine("12 chats · 80% answered by Billie alone"),
        {
          type: "Container",
          selectAction: { type: "Action.OpenUrl", url: "https://billie.test/knowledge#gap-1" },
          items: [plainLine("<https://evil.test|Click me> *now* <!channel>")],
        },
      ],
      actions: [{ type: "Action.OpenUrl", title: "Open Reports", url: "https://billie.test/r" }],
      msteams: {
        entities: [{ type: "mention", text: "<at>Sam</at>", mentioned: { id: "sam@m10.test" } }],
      },
    });
    const { text, blocks, mentionEmails } = slackFromCard(card.attachments[0].content);
    expect(text).toBe("UKCW Exhibitor Help: last week");
    expect(blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "UKCW Exhibitor Help: last week", emoji: false },
    });
    expect(blocks[1]).toMatchObject({ type: "section", text: { type: "plain_text" } });
    // A visitor's words stay plain text, with Billie's own link on a button beside them.
    expect(blocks[2]).toMatchObject({
      text: { type: "plain_text", text: "<https://evil.test|Click me> *now* <!channel>" },
      accessory: { type: "button", url: "https://billie.test/knowledge#gap-1" },
    });
    expect(blocks[3]).toMatchObject({
      type: "actions",
      elements: [{ type: "button", url: "https://billie.test/r" }],
    });
    expect(mentionEmails).toEqual(["sam@m10.test"]);
    expect(JSON.stringify(blocks)).not.toContain('"mrkdwn"');
  });

  it("keeps long posts within Slack's 50 blocks, the links last", () => {
    const body = Array.from({ length: 80 }, (_, i) => plainLine(`Line ${i}`));
    const { blocks } = slackFromCard({
      body,
      actions: [{ type: "Action.OpenUrl", title: "Open", url: "https://billie.test" }],
    });
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.at(-1)).toMatchObject({ type: "actions" });
    expect(JSON.stringify(blocks.at(-2))).toContain("and more in Billie");
  });

  it("mentions people by id only, and escapes anything after", () => {
    expect(block.mention(["U1", "here"], "a <b> & c")).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "<@U1> <!here> a &lt;b&gt; &amp; c" },
    });
    // Slack's limits: a header is at most 150 characters.
    expect((block.header("x".repeat(400)).text as { text: string }).text).toHaveLength(150);
  });

  it("has the same manifest in docs/slack.md as in Settings", () => {
    const guide = readFileSync(path.join(__dirname, "..", "..", "docs", "slack.md"), "utf8");
    const inGuide = /```yaml\n([\s\S]*?)```/.exec(guide)![1];
    expect(inGuide.trim()).toBe(slackManifest("https://billie-teal.vercel.app").trim());
  });

  it("has a manifest with this Billie's own addresses and only the permissions it needs", () => {
    const m = slackManifest("https://billie-teal.vercel.app");
    expect(m).toContain("request_url: https://billie-teal.vercel.app/api/webhooks/slack/events");
    expect(m).toContain(
      "request_url: https://billie-teal.vercel.app/api/webhooks/slack/interactions",
    );
    for (const scope of ["chat:write", "channels:history", "users:read.email", "im:write"])
      expect(m).toContain(`- ${scope}`);
    expect(m).not.toContain("admin");
  });
});

describe("details Billie already has", () => {
  it("needs every field the form would ask, with a real email", () => {
    const fields = ["name", "email", "stand"] as const;
    expect(
      contactComplete([...fields], { name: "Sam", email: "sam@acme.test", stand: "B12" }),
    ).toBe(true);
    expect(contactComplete([...fields], { name: "Sam", email: "sam@acme.test" })).toBe(false);
    expect(contactComplete([...fields], { name: "Sam", email: "not-an-email", stand: "B1" })).toBe(
      false,
    );
    expect(contactComplete([], { name: "Sam" })).toBe(false);
  });
});
