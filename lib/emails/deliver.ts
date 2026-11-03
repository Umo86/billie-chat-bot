import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botMailboxes, bots, emailThreads, users } from "@/lib/db/schema";
import { appUrl, microsoftConfigured } from "@/lib/config";
import { createReplyDraft, removeOwnDraft, tagMessage } from "@/lib/channels/outlook";
import { postToTeams } from "@/lib/channels/teams";
import { cardOf, queueDirect } from "@/lib/alerts/direct";
import { emailTeamsCard, type EmailPost } from "./teams-card";

/**
 * After Billie has drafted a reply to an email from an event mailbox (the
 * "deliver_email_draft" job): the reply goes into the mailbox's Drafts, in
 * the same thread; the email gets Billie's Outlook categories; whoever
 * manages the mailbox gets a Teams message of their own; and the event's
 * Teams channel gets a post that @mentions them. Safe to run again: the
 * Outlook draft is made once, and the manager is messaged once.
 */
export async function deliverEmailDraft(
  emailId: string,
  opts: { replaceDraftId?: string | null; quiet?: boolean } = {},
): Promise<void> {
  const email = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, emailId) });
  if (!email || email.source !== "outlook" || !email.mailbox || !email.externalId) return;
  // Already handled, or being drafted again (that run delivers its own draft).
  if (email.status !== "draft_ready" && email.status !== "needs_you") return;
  if (!microsoftConfigured()) return;

  const [box] = await db
    .select({
      enabled: botMailboxes.enabled,
      assignedUserId: botMailboxes.assignedUserId,
      botName: bots.name,
      teamsWebhookUrl: bots.teamsWebhookUrl,
    })
    .from(botMailboxes)
    .innerJoin(bots, eq(bots.id, botMailboxes.botId))
    .where(and(eq(botMailboxes.address, email.mailbox), isNull(bots.deletedAt)))
    .limit(1);
  // Taken off its bot, or switched off, since the email arrived: leave Outlook alone.
  if (!box?.enabled) return;

  if (opts.replaceDraftId) await removeOwnDraft(email.mailbox, opts.replaceDraftId);
  let draftId = email.outlookDraftId;
  if (!draftId && email.draft.trim()) {
    draftId = await createReplyDraft(email.mailbox, email.externalId, email.draft);
    await db
      .update(emailThreads)
      .set({ outlookDraftId: draftId })
      .where(eq(emailThreads.id, emailId));
  }
  await tagMessage(email.mailbox, email.externalId, [
    email.status === "draft_ready" ? "Billie: draft ready" : "Billie: needs you",
    email.tags?.topic ?? "",
  ]).catch((err) => console.warn("categories not set", err instanceof Error ? err.message : err));

  if (opts.quiet) return;
  const assignee = box.assignedUserId
    ? await db.query.users.findFirst({
        where: and(eq(users.id, box.assignedUserId), eq(users.status, "active")),
        columns: { fullName: true, email: true },
      })
    : null;
  const post: EmailPost = {
    botName: box.botName,
    mailbox: email.mailbox,
    fromName: email.fromName,
    fromEmail: email.fromEmail,
    subject: email.subject,
    summary: email.summary,
    outcome: email.status === "draft_ready" ? "draft" : draftId ? "holding" : "needs_you",
    reason: email.needsYouReason,
    urgent: email.tags?.urgency === "high",
    assignee: assignee
      ? { name: assignee.fullName || assignee.email, email: assignee.email }
      : null,
    link: `${appUrl()}/emails?e=${email.id}`,
  };
  // The manager, in a Teams chat of their own (once direct messages are set up in Settings).
  if (assignee)
    await queueDirect(
      [assignee],
      `email:${email.id}`,
      cardOf(emailTeamsCard({ ...post, assignee: null })),
    );
  // The event's own channel; never the company-wide one, which every event would fill.
  const channel = box.teamsWebhookUrl?.trim();
  if (channel) await postToTeams(channel, emailTeamsCard(post));
}
