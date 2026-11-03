import { describe, expect, it } from "vitest";
import {
  draftFailureIsFinal,
  draftProblem,
  GraphError,
  MicrosoftSignInError,
  mailboxProblem,
  normaliseMailbox,
  replyHtml,
  skipIncoming,
  spliceReply,
  syncWasReset,
  teamsLinkLabel,
  teamsLinkProblem,
  withBillieCategories,
} from "@/lib/emails/mailbox-rules";
import { emailPostLines, emailTeamsCard, type EmailPost } from "@/lib/emails/teams-card";
import { mentionName } from "@/lib/alerts/card";
import { microsoftConfigured } from "@/lib/config";
import { safeError } from "@/lib/errors";

const WORKFLOW =
  "https://prod-12.uksouth.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=secret";

describe("event mailbox rules", () => {
  it("stores mailbox addresses trimmed and in lower case, and refuses anything else", () => {
    expect(normaliseMailbox("  UKCW-Exhibitors@Media-Ten.com ")).toBe(
      "ukcw-exhibitors@media-ten.com",
    );
    expect(normaliseMailbox("not an address")).toBeNull();
    expect(normaliseMailbox("events@")).toBeNull();
  });

  it("accepts Teams Workflows links and nothing that could point elsewhere", () => {
    expect(teamsLinkProblem(WORKFLOW)).toBeNull();
    expect(
      teamsLinkProblem(
        "https://default1234.12.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/x/triggers/manual/paths/invoke?sig=y",
      ),
    ).toBeNull();
    expect(teamsLinkProblem("https://mediaten.webhook.office.com/webhookb2/x")).toBeNull();
    expect(teamsLinkProblem("http://prod-12.uksouth.logic.azure.com/x")).toMatch(/https/);
    expect(teamsLinkProblem("https://logic.azure.com.evil.example/x")).toMatch(/Workflows/);
    expect(teamsLinkProblem("https://user:pass@prod-1.logic.azure.com/x")).not.toBeNull();
    expect(teamsLinkProblem("https://169.254.169.254/latest")).not.toBeNull();
    expect(teamsLinkProblem("teams link")).toMatch(/whole link/);
  });

  it("shows a saved Teams link as its host only, never the secret part", () => {
    expect(teamsLinkLabel(WORKFLOW)).toBe("prod-12.uksouth.logic.azure.com");
    expect(teamsLinkLabel(null)).toBeNull();
  });

  it("leaves auto-replies, bounces, meeting replies and the mailbox's own mail alone", () => {
    const mailbox = "events@media-ten.com";
    const skip = (from: string, subject: string) => skipIncoming({ from, subject, mailbox });
    expect(skip("sam@stands.example", "Build-up question")).toBe(false);
    expect(skip("sam@stands.example", "Re: Build-up question")).toBe(false);
    expect(skip("sam@stands.example", "Automatic reply: Exhibitor manual")).toBe(true);
    expect(skip("sam@stands.example", "Out of Office: back Monday")).toBe(true);
    expect(skip("sam@stands.example", "Accepted: Site visit")).toBe(true);
    expect(skip("MAILER-DAEMON@mx.example", "Mail delivery failed")).toBe(true);
    expect(skip("no-reply@portal.example", "Your order")).toBe(true);
    expect(skip("noreply+abc@portal.example", "Your order")).toBe(true);
    expect(skip(mailbox, "Fwd: plan")).toBe(true);
    expect(skip("", "No sender")).toBe(true);
    // A real person whose name merely starts like an auto-sender is fine.
    expect(skip("norah@stands.example", "Question")).toBe(false);
  });

  it("keeps line breaks in the Outlook draft and escapes the text", () => {
    const html = replyHtml(
      "Hi Sam,\r\n\r\nBuild-up starts at 8am <Monday>.\nKind regards,\nOps & team",
    );
    expect(html).toContain("Hi Sam,<br><br>Build-up starts at 8am &lt;Monday&gt;.<br>");
    expect(html).toContain("Ops &amp; team");
    expect(html).toContain("font-family:");
    expect(html).not.toContain("<Monday>");
  });

  it("puts the reply above the quoted email, inside the body", () => {
    const draft =
      '<html><head><style>p{}</style></head><body dir="ltr"><div>quoted</div></body></html>';
    expect(spliceReply(draft, "<div>reply</div>")).toBe(
      '<html><head><style>p{}</style></head><body dir="ltr"><div>reply</div><div>quoted</div></body></html>',
    );
    expect(spliceReply("<div>quoted</div>", "<div>reply</div>")).toBe(
      "<div>reply</div><div>quoted</div>",
    );
  });

  it("replaces Billie's categories and keeps the team's", () => {
    expect(
      withBillieCategories(["VIP", "Billie: needs you"], ["Billie: draft ready", "Badges", ""]),
    ).toEqual(["VIP", "Billie: draft ready", "Badges"]);
  });

  it("explains mailbox problems in words, and spots an expired sync point", () => {
    expect(mailboxProblem(new GraphError(403, "ErrorAccessDenied", "x"))).toMatch(
      /isn't allowed into this mailbox/,
    );
    expect(mailboxProblem(new GraphError(404, "ErrorInvalidUser", "x"))).toMatch(
      /can't find this mailbox/,
    );
    expect(mailboxProblem(new GraphError(429, "", "x"))).toMatch(/slow down/);
    expect(mailboxProblem(new MicrosoftSignInError("invalid_client"))).toMatch(/MS_CLIENT_SECRET/);
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(mailboxProblem(timeout)).toMatch(/didn't answer in time/);
    expect(syncWasReset(new GraphError(410, "", "gone"))).toBe(true);
    expect(syncWasReset(new GraphError(400, "SyncStateNotFound", "x"))).toBe(true);
    expect(syncWasReset(new GraphError(403, "ErrorAccessDenied", "x"))).toBe(false);
  });

  it("tells a draft failure that won't fix itself from one worth trying again", () => {
    expect(draftFailureIsFinal(new GraphError(403, "ErrorAccessDenied", "x"))).toBe(true);
    expect(draftFailureIsFinal(new GraphError(404, "ErrorItemNotFound", "x"))).toBe(true);
    expect(draftFailureIsFinal(new GraphError(503, "ServerBusy", "x"))).toBe(false);
    expect(draftFailureIsFinal(new GraphError(429, "", "x"))).toBe(false);
    expect(draftFailureIsFinal(new Error("socket hang up"))).toBe(false);
    expect(draftProblem(new GraphError(403, "ErrorAccessDenied", "x"))).toMatch(
      /isn't allowed to save drafts in it\. Ask IT .*Application Mail\.ReadWrite/,
    );
    expect(draftProblem(new GraphError(404, "ErrorItemNotFound", "x"))).toMatch(
      /moved or deleted in Outlook/,
    );
  });

  it("logs errors without the values a database query carried", () => {
    const err = new Error(
      'Failed query: insert into "bots" ("teams_webhook_url") values ($1)\nparams: https://prod-1.logic.azure.com/x?sig=secret',
    );
    err.cause = Object.assign(new Error('invalid input syntax for type uuid: "abc-secret"'), {
      name: "DatabaseError",
    });
    const line = safeError(err);
    expect(line).toContain('Failed query: insert into "bots"');
    expect(line).toContain("(values left out)");
    expect(line).toContain("DatabaseError: invalid input syntax for type uuid:");
    expect(line).not.toContain("secret");
    expect(safeError("plain")).toBe("plain");
  });

  it("needs the tenant, app and secret to connect Microsoft 365, and no single mailbox", () => {
    expect(
      microsoftConfigured({ MS_TENANT_ID: "t", MS_CLIENT_ID: "c", MS_CLIENT_SECRET: "s" }),
    ).toBe(true);
    expect(microsoftConfigured({ MS_TENANT_ID: "t", MS_CLIENT_ID: "c" })).toBe(false);
  });
});

describe("the Teams post for a new email", () => {
  const post: EmailPost = {
    botName: "UKCW Exhibitor Help",
    mailbox: "ukcw-exhibitors@media-ten.com",
    fromName: "Sam Carter",
    fromEmail: "sam@stands.example",
    subject: "Build-up question",
    summary: "When build-up starts",
    outcome: "draft",
    inOutlook: true,
    reason: null,
    urgent: false,
    assignee: { name: "Umit Bozdag", email: "umit@media-ten.com" },
    link: "https://billie.example/emails?e=1",
  };

  it("says a reply is waiting in Drafts, and where", () => {
    const { title, lines } = emailPostLines(post);
    expect(title).toBe("UKCW Exhibitor Help: a reply is waiting in Drafts");
    expect(lines).toContain("From: Sam Carter (sam@stands.example)");
    expect(lines).toContain("They want: When build-up starts");
    expect(lines.at(-1)).toBe(
      "Billie's reply is in Drafts in ukcw-exhibitors@media-ten.com. Check it, then send it from Outlook.",
    );
  });

  it("says when Billie wasn't sure, or wrote nothing", () => {
    const holding = emailPostLines({
      ...post,
      outcome: "holding",
      reason: "Not in the knowledge base: parking prices",
      urgent: true,
    });
    expect(holding.title).toBe("UKCW Exhibitor Help: an email needs a person");
    expect(holding.lines).toContain("Billie thinks this is urgent.");
    expect(holding.lines).toContain("Not in the knowledge base: parking prices");
    expect(holding.lines.at(-1)).toMatch(/A holding reply is in Drafts/);
    const none = emailPostLines({ ...post, outcome: "needs_you", reason: null });
    expect(none.lines.at(-1)).toBe("There's no draft. Reply from ukcw-exhibitors@media-ten.com.");
  });

  it("says so when Outlook wouldn't take the draft, and where the reply is instead", () => {
    const refused = emailPostLines({ ...post, inOutlook: false });
    expect(refused.title).toBe("UKCW Exhibitor Help: a reply is ready in Billie");
    expect(refused.lines.at(-1)).toBe(
      "Billie's reply couldn't be saved in Drafts in ukcw-exhibitors@media-ten.com. Open it in Billie, check it and copy it into your reply.",
    );
    const holding = emailPostLines({ ...post, outcome: "holding", inOutlook: false, reason: null });
    expect(holding.lines.at(-1)).toMatch(/A holding reply is in Billie \(it couldn't be saved/);
  });

  it("@mentions the mailbox manager and links to the email in Billie", () => {
    const card = emailTeamsCard(post);
    const content = card.attachments[0].content;
    expect(JSON.stringify(content.body)).toContain("For <at>Umit Bozdag</at>");
    expect(content.msteams).toEqual({
      entities: [
        {
          type: "mention",
          text: "<at>Umit Bozdag</at>",
          mentioned: { id: "umit@media-ten.com", name: "Umit Bozdag" },
        },
      ],
    });
    expect(content.actions?.[0]).toMatchObject({ type: "Action.OpenUrl", url: post.link });
    expect(emailTeamsCard({ ...post, assignee: null }).attachments[0].content.msteams).toBe(
      undefined,
    );
  });

  it("shows what the sender wrote as plain text, so no link can be slipped in", () => {
    const card = emailTeamsCard({ ...post, subject: "[Click here](https://evil.example)" });
    const blocks = card.attachments[0].content.body as {
      type: string;
      inlines?: { text: string }[];
    }[];
    const subject = blocks.find((b) => b.inlines?.[0]?.text.startsWith("Subject:"));
    expect(subject?.type).toBe("RichTextBlock");
    expect(blocks.filter((b) => b.type === "TextBlock")).toHaveLength(1); // only the mention
    expect(mentionName("Sam [x](y) *Bold*")).toBe("Sam xy Bold");
  });
});
