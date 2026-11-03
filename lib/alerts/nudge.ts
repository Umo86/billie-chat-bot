import "server-only";
import { and, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, conversations, emailThreads, users } from "@/lib/db/schema";
import { EVERY_BOT_ROLES } from "@/lib/authz";
import { worksOnBotSql } from "@/lib/auth/bots";
import { appUrl } from "@/lib/config";
import { getSettings } from "@/lib/settings";
import { workingMinutes } from "@/lib/conversations/hours";
import { formatDateTime } from "@/lib/time";
import type { ContactDetails } from "@/lib/types";
import { adaptiveMessage, plainLine } from "./card";
import { cardOf, directLink, eventManager, queueDirect } from "./direct";

/**
 * Nudges: a chat passed to the team, or an email that needs a person, with
 * no reply after N of the bot's working hours (Settings, default 4) gets a
 * Teams message to whoever handles it: the person on the chat, or the event
 * mailbox's manager. After the second number (default 8) admins get one
 * too. Each is sent once per handover (queued once, keyed by it); runs every
 * 15 minutes. Nothing happens until Teams direct messages are set up.
 */

export type Nudge = {
  level: 1 | 2;
  kind: "chat" | "email";
  botName: string;
  who: string;
  what: string;
  since: Date;
  link: string;
};

export function nudgeCard(n: Nudge) {
  const thing = n.kind === "chat" ? "A chat" : "An email";
  return adaptiveMessage({
    body: [
      plainLine(
        n.level === 1
          ? `${thing} is still waiting for a reply`
          : `${thing} has had no reply for a working day`,
        { bold: true, size: "Medium" },
      ),
      plainLine(`${n.botName} · ${n.who}`, { spacing: "None" }),
      ...(n.what ? [plainLine(`"${n.what.slice(0, 300)}"`)] : []),
      plainLine(`Waiting since ${formatDateTime(n.since)}.`),
    ],
    actions: [{ type: "Action.OpenUrl", title: "Open in Billie", url: n.link }],
  });
}

function who(contact: ContactDetails, waId: string | null): string {
  const name = [contact.name, contact.company].filter(Boolean).join(", ");
  return name || (waId ? `+${waId}` : "A visitor");
}

/** The "nudge_waiting" job. Returns how many Teams messages it queued. */
export async function runNudges(now = new Date()): Promise<number> {
  const s = await getSettings();
  const first = Math.max(0, s.nudgeAfterHours) * 60;
  const second = Math.max(0, s.escalateAfterHours) * 60;
  if (!first && !second) return 0;
  if (!(await directLink())) return 0;
  const cap = Math.max(first, second);
  const since = new Date(now.getTime() - 21 * 86_400_000);
  const admins = second
    ? await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.status, "active"), inArray(users.role, [...EVERY_BOT_ROLES])))
    : [];
  let queued = 0;

  const chats = await db
    .select({
      id: conversations.id,
      botId: conversations.botId,
      handoverAt: conversations.handoverAt,
      assignedTo: conversations.assignedTo,
      contact: conversations.contact,
      waId: conversations.waId,
      firstQuestion: conversations.firstQuestion,
      botName: bots.name,
      rules: bots.rules,
    })
    .from(conversations)
    .innerJoin(bots, eq(bots.id, conversations.botId))
    .where(
      and(
        inArray(conversations.status, ["waiting", "ticket"]),
        isNotNull(conversations.handoverAt),
        gt(conversations.handoverAt, since),
        ne(conversations.channel, "try"),
        isNull(bots.deletedAt),
      ),
    )
    .limit(500);
  for (const c of chats) {
    const at = c.handoverAt!;
    const waited = workingMinutes(c.rules.hours, at, now, cap);
    const nudge: Omit<Nudge, "level"> = {
      kind: "chat",
      botName: c.botName,
      who: who(c.contact as ContactDetails, c.waId),
      what: c.firstQuestion,
      since: at,
      link: `${appUrl()}/inbox?c=${c.id}`,
    };
    const key = `nudge:chat:${c.id}:${at.getTime()}`;
    if (first && waited >= first) {
      // Whoever has the chat, if they still work on the bot; else the event mailbox's manager.
      const assignee = c.assignedTo
        ? await db
            .select({ email: users.email })
            .from(users)
            .where(
              and(eq(users.id, c.assignedTo), eq(users.status, "active"), worksOnBotSql(c.botId)),
            )
        : [];
      const people = assignee.length ? assignee : await eventManager(c.botId);
      queued += await queueDirect(people, `${key}:1`, cardOf(nudgeCard({ ...nudge, level: 1 })));
    }
    if (second && waited >= second)
      queued += await queueDirect(admins, `${key}:2`, cardOf(nudgeCard({ ...nudge, level: 2 })));
  }

  const emails = await db
    .select({
      id: emailThreads.id,
      botId: emailThreads.botId,
      receivedAt: emailThreads.receivedAt,
      fromName: emailThreads.fromName,
      fromEmail: emailThreads.fromEmail,
      subject: emailThreads.subject,
      routedTo: emailThreads.routedTo,
      botName: bots.name,
      rules: bots.rules,
    })
    .from(emailThreads)
    .innerJoin(bots, eq(bots.id, emailThreads.botId))
    .where(
      and(
        eq(emailThreads.status, "needs_you"),
        gt(emailThreads.receivedAt, since),
        isNull(bots.deletedAt),
      ),
    )
    .limit(500);
  for (const e of emails) {
    const waited = workingMinutes(e.rules.hours, e.receivedAt, now, cap);
    const nudge: Omit<Nudge, "level"> = {
      kind: "email",
      botName: e.botName,
      who: e.fromName || e.fromEmail || "Someone",
      what: e.subject,
      since: e.receivedAt,
      link: `${appUrl()}/emails?e=${e.id}`,
    };
    const key = `nudge:email:${e.id}:${e.receivedAt.getTime()}`;
    if (first && waited >= first) {
      // Whoever handles its topic, if they still work on the bot; else the mailbox's manager.
      const routed = e.routedTo
        ? await db
            .select({ email: users.email })
            .from(users)
            .where(
              and(eq(users.id, e.routedTo), eq(users.status, "active"), worksOnBotSql(e.botId!)),
            )
        : [];
      queued += await queueDirect(
        routed.length ? routed : await eventManager(e.botId!),
        `${key}:1`,
        cardOf(nudgeCard({ ...nudge, level: 1 })),
      );
    }
    if (second && waited >= second)
      queued += await queueDirect(admins, `${key}:2`, cardOf(nudgeCard({ ...nudge, level: 2 })));
  }
  return queued;
}
