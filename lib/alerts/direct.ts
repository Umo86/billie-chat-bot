import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentPresence, botMailboxes, settings, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";
import { enqueue } from "@/lib/jobs/queue";
import { postToTeams } from "@/lib/channels/teams";
import { teamsLinkLabel, teamsLinkProblem } from "@/lib/emails/mailbox-rules";
import { getSettings } from "@/lib/settings";

/**
 * Teams direct messages: a 1:1 chat with one person, from the Workflows
 * bot, through one company-wide Power Automate workflow ("When a Teams
 * webhook request is received", then "Post card in a chat or channel" to
 * "Chat with Flow bot"). Billie sends the person's Microsoft 365 address and
 * the card; Microsoft Graph doesn't let an app start 1:1 chats itself.
 * Each message is its own job ("teams_direct"), queued once, so a retry of
 * whatever queued it never messages someone twice.
 */
export async function directLink(): Promise<string | null> {
  return (await getSettings()).teamsDmWebhookUrl?.trim() || null;
}

/** What the screen shows: the link's host, never the link. */
export async function directLinkLabel(): Promise<string | null> {
  return teamsLinkLabel(await directLink());
}

export async function setDirectLink(actor: Actor, link: string | null): Promise<void> {
  const clean = link?.trim() || null;
  if (clean) {
    const problem = teamsLinkProblem(clean);
    if (problem) throw new UserError(problem);
  }
  await getSettings(); // makes sure the settings row exists
  await db.transaction(async (tx) => {
    await tx.update(settings).set({ teamsDmWebhookUrl: clean }).where(eq(settings.id, "main"));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "settings",
      entityId: null,
      action: "settings_change",
      summary: clean
        ? `Set up Teams direct messages (${teamsLinkLabel(clean)})`
        : "Turned off Teams direct messages",
    });
  });
}

/** The Adaptive Card inside a Teams message (what the workflow posts). */
export function cardOf(message: { attachments: { content: unknown }[] }): unknown {
  return message.attachments[0]?.content;
}

/**
 * Queues one Teams message to each person, once per `key`. Does nothing
 * until Teams direct messages are set up in Settings.
 */
export async function queueDirect(
  people: { email: string }[],
  key: string,
  card: unknown,
): Promise<number> {
  if (!people.length || !(await directLink())) return 0;
  let queued = 0;
  for (const p of people) {
    const to = p.email.trim().toLowerCase();
    if (!to) continue;
    const id = await enqueue(
      "teams_direct",
      { to, card },
      { dedupeKey: `dm:${key}:${to}`, once: true },
    );
    if (id) queued++;
  }
  return queued;
}

/** The "teams_direct" job: posts the card to the workflow, for one person. */
export async function sendDirect(to: string, card: unknown): Promise<void> {
  const link = await directLink();
  if (!link) return; // turned off since it was queued
  // The workflow's "Adaptive Card" box takes the card as JSON text.
  await postToTeams(link, { recipient: to, card: JSON.stringify(card) });
}

/** Whoever manages the bot's event mailbox, if they can still sign in. */
export async function eventManager(botId: string): Promise<{ email: string }[]> {
  return db
    .select({ email: users.email })
    .from(botMailboxes)
    .innerJoin(users, eq(users.id, botMailboxes.assignedUserId))
    .where(and(eq(botMailboxes.botId, botId), eq(users.status, "active")));
}

/** Active people marked available for live chats right now. */
export async function availablePeople(now = new Date()): Promise<{ email: string }[]> {
  return db
    .select({ email: users.email })
    .from(agentPresence)
    .innerJoin(users, eq(users.id, agentPresence.userId))
    .where(and(gt(agentPresence.availableUntil, now), eq(users.status, "active")));
}
