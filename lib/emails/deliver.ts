import "server-only";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botMailboxes, bots, emailThreads, users } from "@/lib/db/schema";
import { appUrl, microsoftConfigured } from "@/lib/config";
import {
  createReplyDraft,
  discardNewDraft,
  removeUntouchedDraft,
  tagMessage,
  type OutlookDraft,
} from "@/lib/channels/outlook";
import { postToTeams } from "@/lib/channels/teams";
import { cardOf, queueDirect } from "@/lib/alerts/direct";
import { worksOnBotSql } from "@/lib/auth/bots";
import { safeError } from "@/lib/errors";
import { draftFailureIsFinal, draftProblem } from "./mailbox-rules";
import { emailTeamsCard, type EmailPost } from "./teams-card";

/** Which text an Outlook draft holds. */
export function draftVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/**
 * After Billie has drafted a reply to an email from an event mailbox (the
 * "deliver_email_draft" job): the reply goes into the mailbox's Drafts, in
 * the same thread; the email gets Billie's Outlook categories; whoever
 * manages the mailbox gets a Teams message of their own; and the event's
 * Teams channel gets a post that @mentions them.
 *
 * Safe to run again, and alongside another run for the same email: Outlook
 * gets one draft per version of Billie's text (a new text, after "Write it
 * again", gets a new draft, and the old one goes only if nobody has touched
 * it). When Outlook refuses the draft for good (no write access, the email
 * is gone), or on the last try, the problem is saved for the screen and the
 * team is still told, with the reply waiting in Billie instead.
 */
export async function deliverEmailDraft(
  emailId: string,
  opts: { quiet?: boolean; lastTry?: boolean } = {},
): Promise<void> {
  const email = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, emailId) });
  if (!email || email.source !== "outlook" || !email.mailbox || !email.externalId) return;
  // Already handled, or being drafted again (that run delivers its own draft).
  if (email.status !== "draft_ready" && email.status !== "needs_you") return;
  if (!microsoftConfigured()) return;

  const [box] = await db
    .select({
      id: botMailboxes.id,
      enabled: botMailboxes.enabled,
      assignedUserId: botMailboxes.assignedUserId,
      botId: bots.id,
      botName: bots.name,
      teamsWebhookUrl: bots.teamsWebhookUrl,
    })
    .from(botMailboxes)
    .innerJoin(bots, eq(bots.id, botMailboxes.botId))
    .where(and(eq(botMailboxes.address, email.mailbox), isNull(bots.deletedAt)))
    .limit(1);
  // Taken off its bot, or switched off, since the email arrived: leave Outlook alone.
  if (!box?.enabled) return;

  const text = email.draft.trim();
  const version = draftVersion(email.draft);
  let inOutlook = Boolean(email.outlookDraftId) && email.outlookDraftVersion === version;
  if (text && !inOutlook) {
    try {
      await saveDraftInOutlook(email, version);
      inOutlook = true;
      await db.update(botMailboxes).set({ draftError: null }).where(eq(botMailboxes.id, box.id));
    } catch (err) {
      if (!draftFailureIsFinal(err) && !opts.lastTry) throw err; // tried again with backoff
      const problem = draftProblem(err);
      console.warn("draft not saved in Outlook:", safeError(err));
      await db
        .update(emailThreads)
        .set({ error: `Billie couldn't save this reply in Outlook. ${problem}` })
        .where(eq(emailThreads.id, emailId));
      await db.update(botMailboxes).set({ draftError: problem }).where(eq(botMailboxes.id, box.id));
    }
  }
  await tagMessage(email.mailbox, email.externalId, [
    email.status === "draft_ready" ? "Billie: draft ready" : "Billie: needs you",
    email.tags?.topic ?? "",
  ]).catch((err) => console.warn("categories not set:", safeError(err)));

  if (opts.quiet) return;
  // The manager, if they still work on the bot (a link they couldn't open is no use).
  const assignee = box.assignedUserId
    ? await db.query.users.findFirst({
        where: and(
          eq(users.id, box.assignedUserId),
          eq(users.status, "active"),
          worksOnBotSql(box.botId),
        ),
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
    outcome: email.status === "draft_ready" ? "draft" : text ? "holding" : "needs_you",
    inOutlook,
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

type EmailRow = typeof emailThreads.$inferSelect;

/**
 * Makes the Outlook draft for this text, then records it only if the email
 * still has the text and the draft Billie read at the start. If another run
 * got there first, Billie's new draft is thrown away (nobody has seen it);
 * otherwise Billie's previous draft is removed if nobody has touched it.
 */
async function saveDraftInOutlook(email: EmailRow, version: string): Promise<void> {
  const mailbox = email.mailbox!;
  const created = await createReplyDraft(mailbox, email.externalId!, email.draft);
  let previous: OutlookDraft | null = email.outlookDraftId
    ? { id: email.outlookDraftId, etag: email.outlookDraftEtag }
    : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const [saved] = await db
      .update(emailThreads)
      .set({
        outlookDraftId: created.id,
        outlookDraftEtag: created.etag,
        outlookDraftVersion: version,
        error: null,
      })
      .where(
        and(
          eq(emailThreads.id, email.id),
          eq(emailThreads.draft, email.draft),
          previous
            ? eq(emailThreads.outlookDraftId, previous.id)
            : isNull(emailThreads.outlookDraftId),
        ),
      )
      .returning({ id: emailThreads.id });
    if (saved) {
      if (previous)
        await removeUntouchedDraft(mailbox, previous).catch((err) =>
          console.warn("old draft left in Drafts:", safeError(err)),
        );
      return;
    }
    // Something changed meanwhile: look again.
    const now = await db.query.emailThreads.findFirst({
      where: eq(emailThreads.id, email.id),
      columns: {
        draft: true,
        outlookDraftId: true,
        outlookDraftEtag: true,
        outlookDraftVersion: true,
      },
    });
    if (!now || now.draft !== email.draft || now.outlookDraftVersion === version) {
      // A newer text is on its way, or this text is already in Drafts: ours isn't needed.
      await discardNewDraft(mailbox, created).catch((err) =>
        console.warn("spare draft not removed:", safeError(err)),
      );
      return;
    }
    previous = now.outlookDraftId ? { id: now.outlookDraftId, etag: now.outlookDraftEtag } : null;
  }
  await discardNewDraft(mailbox, created).catch(() => undefined);
  throw new Error("The email kept changing while its draft was saved");
}
