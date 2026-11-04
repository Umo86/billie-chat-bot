import "server-only";
import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botMailboxes, bots, emailThreads, users } from "@/lib/db/schema";
import { appUrl } from "@/lib/config";
import { enqueue } from "@/lib/jobs/queue";
import { postMessage, slackUserIdFor } from "@/lib/channels/slack";
import { block, type SlackBlock } from "@/lib/channels/slack-rules";
import { slackChannelFor } from "@/lib/alerts/slack-chat";
import { slackPeopleFor } from "@/lib/bots/slack-people";

/**
 * Email replies to check, in the event's Slack channel, once Slack is
 * connected: "I've prepared these replies, please review and send". The
 * emails Billie deals with over two minutes go in one post (each email in
 * one post only, marked as it goes), naming whoever manages the mailbox and
 * whoever handles an email's topic. Billie never sends an email itself.
 */
export const DIGEST_MS = 2 * 60_000;
const MAX_LISTED = 15;

/** After Billie has drafted (or flagged) an email: the bot's next post picks it up. */
export async function queueEmailDigest(botId: string, now = Date.now()): Promise<void> {
  const bucket = Math.floor(now / DIGEST_MS);
  await enqueue(
    "slack_email_digest",
    { botId },
    {
      dedupeKey: `slack-digest:${botId}:${bucket}`,
      once: true,
      runAt: new Date((bucket + 1) * DIGEST_MS),
    },
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The "slack_email_digest" job. */
export async function postEmailDigest(botId: string, now = new Date()): Promise<void> {
  const channel = await slackChannelFor(botId, { ownOnly: true });
  if (!channel) return;
  const [box] = await db
    .select({ address: botMailboxes.address, managerEmail: users.email, botName: bots.name })
    .from(botMailboxes)
    .innerJoin(bots, eq(bots.id, botMailboxes.botId))
    .leftJoin(users, and(eq(users.id, botMailboxes.assignedUserId), eq(users.status, "active")))
    .where(eq(botMailboxes.botId, botId))
    .limit(1);
  if (!box) return;
  const since = new Date(now.getTime() - 7 * 86_400_000);
  await db.transaction(async (tx) => {
    // Claimed here, marked below: a post that fails leaves them for the retry.
    const rows = await tx
      .select({
        id: emailThreads.id,
        subject: emailThreads.subject,
        fromName: emailThreads.fromName,
        fromEmail: emailThreads.fromEmail,
        summary: emailThreads.summary,
        status: emailThreads.status,
        reason: emailThreads.needsYouReason,
        inOutlook: sql<boolean>`${emailThreads.outlookDraftId} IS NOT NULL`,
        routedEmail: users.email,
      })
      .from(emailThreads)
      .leftJoin(users, and(eq(users.id, emailThreads.routedTo), eq(users.status, "active")))
      .where(
        and(
          eq(emailThreads.mailbox, box.address),
          isNull(emailThreads.slackPostedAt),
          inArray(emailThreads.status, ["draft_ready", "needs_you"]),
          gt(emailThreads.receivedAt, since),
        ),
      )
      .orderBy(emailThreads.receivedAt)
      .limit(100)
      .for("update", { of: emailThreads, skipLocked: true });
    if (!rows.length) return;

    const drafted = rows.filter((r) => r.status === "draft_ready");
    const needYou = rows.filter((r) => r.status === "needs_you");
    const title = `${box.botName}: email replies to check`;
    const opening = [
      drafted.length
        ? `I've prepared ${plural(drafted.length, "reply", "replies")} in ${box.address}. Please review and send ${drafted.length === 1 ? "it" : "them"}.`
        : "",
      needYou.length
        ? `${plural(needYou.length, "email needs", "emails need")} a person: Billie left a holding reply where it could.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    const blocks: SlackBlock[] = [block.header(title), block.line(opening)];
    const ids: string[] = [];
    // The mailbox's manager, whoever handles an email's topic, and the show's Slack people.
    const team = await slackPeopleFor(botId);
    for (const email of [box.managerEmail, ...rows.map((r) => r.routedEmail), ...team]) {
      if (!email) continue;
      const id = await slackUserIdFor(email).catch(() => null);
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length) blocks.push(block.mention(ids));
    for (const r of rows.slice(0, MAX_LISTED)) {
      const from = r.fromName || r.fromEmail || "Someone";
      const what =
        r.status === "needs_you"
          ? `Needs you${r.reason ? `: ${r.reason}` : ""}`
          : r.inOutlook
            ? "Draft ready in Outlook"
            : "Reply ready in Billie (not saved in Outlook)";
      blocks.push(
        block.linked(
          `${r.subject || "(no subject)"}\nFrom ${from}${r.summary ? `: ${r.summary}` : ""}\n${what}`,
          `${appUrl()}/emails?e=${r.id}`,
        ),
      );
    }
    if (rows.length > MAX_LISTED)
      blocks.push(block.note(`…and ${rows.length - MAX_LISTED} more in Billie.`));
    blocks.push(
      block.buttons([
        { text: "Open the emails in Billie", url: `${appUrl()}/emails?bot=${botId}` },
      ]),
    );
    await postMessage({ channel, text: title, blocks });
    await tx
      .update(emailThreads)
      .set({ slackPostedAt: now })
      .where(
        inArray(
          emailThreads.id,
          rows.map((r) => r.id),
        ),
      );
  });
}

/** Emails dealt with but not yet in a post (for tests and the minute tick). */
export async function unpostedEmails(botId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailThreads)
    .where(
      and(
        eq(emailThreads.botId, botId),
        isNull(emailThreads.slackPostedAt),
        isNotNull(emailThreads.mailbox),
        inArray(emailThreads.status, ["draft_ready", "needs_you"]),
      ),
    );
  return row?.n ?? 0;
}
