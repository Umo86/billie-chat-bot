import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, bots, chatRequests, conversations, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { enqueue, PermanentJobError } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { appUrl, emailConfigured } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { postToTeams } from "@/lib/channels/teams";
import { adaptiveMessage, plainLine } from "@/lib/alerts/card";
import { cardOf, eventManager, queueDirect } from "@/lib/alerts/direct";
import { sendEmail } from "@/lib/email/send";
import type { Actor } from "@/lib/authz";
import type { ContactDetails, RequestAnswer, RequestStatus } from "@/lib/types";
import {
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TEXT,
  requestFrom,
  requestRef,
  showValue,
} from "./rules";

/**
 * Requests from chat, on the team's side: the Requests page (who handles
 * each one, its status, a message to the person), the person's own page
 * (/r/<token>), and telling people: the team in Teams when one arrives,
 * the person by email when it changes (once email is set up).
 */
export type RequestTab = "new" | "in_progress" | "finished";

export type RequestRow = {
  id: string;
  ref: string;
  typeName: string;
  status: RequestStatus;
  from: string;
  botName: string;
  assignedName: string | null;
  createdAt: string;
  /** Sent from a test chat (Try a bot, or the bot's Test step). */
  test: boolean;
};

const TAB_STATUS: Record<RequestTab, RequestStatus[]> = {
  new: ["new"],
  in_progress: ["in_progress"],
  finished: ["done", "declined"],
};

export async function requestCounts(): Promise<Record<RequestTab, number>> {
  const rows = await db
    .select({ status: chatRequests.status, n: sql<number>`count(*)::int` })
    .from(chatRequests)
    .groupBy(chatRequests.status);
  const n = (s: RequestStatus) => rows.find((r) => r.status === s)?.n ?? 0;
  return { new: n("new"), in_progress: n("in_progress"), finished: n("done") + n("declined") };
}

export async function requestList(tab: RequestTab): Promise<RequestRow[]> {
  const rows = await db
    .select({
      id: chatRequests.id,
      ref: chatRequests.ref,
      typeName: chatRequests.typeName,
      status: chatRequests.status,
      contact: chatRequests.contact,
      botName: bots.name,
      assignedName: users.fullName,
      assignedEmail: users.email,
      createdAt: chatRequests.createdAt,
      channel: conversations.channel,
    })
    .from(chatRequests)
    .innerJoin(bots, eq(bots.id, chatRequests.botId))
    .leftJoin(users, eq(users.id, chatRequests.assignedTo))
    .leftJoin(conversations, eq(conversations.id, chatRequests.conversationId))
    .where(inArray(chatRequests.status, TAB_STATUS[tab]))
    // Waiting work oldest first; finished work newest first.
    .orderBy(tab === "finished" ? desc(chatRequests.updatedAt) : asc(chatRequests.createdAt))
    .limit(200);
  return rows.map((r) => ({
    id: r.id,
    ref: requestRef(r.ref),
    typeName: r.typeName,
    status: r.status,
    from: requestFrom(r.contact as ContactDetails),
    botName: r.botName,
    assignedName: r.assignedName || r.assignedEmail || null,
    createdAt: r.createdAt.toISOString(),
    test: r.channel === "try",
  }));
}

export type RequestDetail = {
  id: string;
  ref: string;
  typeName: string;
  status: RequestStatus;
  answers: RequestAnswer[];
  contact: ContactDetails;
  note: string;
  botName: string;
  showName: string;
  conversationId: string | null;
  assignedTo: string | null;
  trackUrl: string;
  createdAt: string;
  updatedAt: string;
  history: { at: string; who: string; what: string }[];
  test: boolean;
};

export async function requestDetail(id: string): Promise<RequestDetail | null> {
  const [r] = await db
    .select({
      req: chatRequests,
      botName: bots.name,
      showName: bots.showName,
      channel: conversations.channel,
    })
    .from(chatRequests)
    .innerJoin(bots, eq(bots.id, chatRequests.botId))
    .leftJoin(conversations, eq(conversations.id, chatRequests.conversationId))
    .where(eq(chatRequests.id, id))
    .limit(1);
  if (!r) return null;
  const history = await db
    .select({
      at: auditLog.createdAt,
      what: auditLog.summary,
      name: users.fullName,
      email: users.email,
      actorType: auditLog.actorType,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(eq(auditLog.entityType, "request"), eq(auditLog.entityId, id)))
    .orderBy(asc(auditLog.createdAt))
    .limit(50);
  return {
    id: r.req.id,
    ref: requestRef(r.req.ref),
    typeName: r.req.typeName,
    status: r.req.status,
    answers: (r.req.answers as RequestAnswer[]).map((a) => ({ ...a, value: showValue(a.value) })),
    contact: r.req.contact as ContactDetails,
    note: r.req.note,
    botName: r.botName,
    showName: r.showName,
    conversationId: r.req.conversationId,
    assignedTo: r.req.assignedTo,
    trackUrl: `${appUrl()}/r/${r.req.trackToken}`,
    createdAt: r.req.createdAt.toISOString(),
    updatedAt: r.req.updatedAt.toISOString(),
    history: history.map((h) => ({
      at: h.at.toISOString(),
      who: h.actorType === "visitor" ? "From the chat" : h.name || h.email || "Billie",
      what: h.what,
    })),
    test: r.channel === "try",
  };
}

/** The people who can be given a request: everyone active on the team. */
export async function requestHandlers(): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({ id: users.id, name: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.status, "active"))
    .orderBy(asc(users.fullName));
  return rows.map((u) => ({ id: u.id, name: u.name ? `${u.name} (${u.email})` : u.email }));
}

export type RequestPatch = {
  status?: RequestStatus;
  note?: string;
  assignedTo?: string | null;
};

function updateKey(id: string, status: string, note: string): string {
  const v = createHash("sha256").update(status).update("\u0000").update(note).digest("hex");
  return `request-update:${id}:${v.slice(0, 16)}`;
}

/** Changes a request; emails the person when its status or message changes. */
export async function updateRequest(actor: Actor, id: string, patch: RequestPatch): Promise<void> {
  const emailed = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(chatRequests).where(eq(chatRequests.id, id)).for("update");
    if (!r) throw new UserError("That request no longer exists.");
    const ref = requestRef(r.ref);
    const changes: Partial<typeof chatRequests.$inferInsert> = {};
    const said: string[] = [];

    if (patch.assignedTo !== undefined && patch.assignedTo !== r.assignedTo) {
      let name = "nobody";
      if (patch.assignedTo) {
        const u = await tx.query.users.findFirst({
          where: and(eq(users.id, patch.assignedTo), eq(users.status, "active")),
          columns: { fullName: true, email: true },
        });
        if (!u) throw new UserError("That person can't take requests. Pick someone else.");
        name = u.fullName || u.email;
      }
      changes.assignedTo = patch.assignedTo;
      said.push(`gave ${ref} to ${name}`);
    }
    const note = patch.note?.trim();
    if (note !== undefined && note !== r.note) {
      changes.note = note.slice(0, 2000);
      said.push(note ? `updated the message on ${ref}` : `cleared the message on ${ref}`);
    }
    if (patch.status && patch.status !== r.status) {
      changes.status = patch.status;
      changes.closedAt = ["done", "declined"].includes(patch.status) ? new Date() : null;
      said.push(`marked ${ref} as ${REQUEST_STATUS_LABEL[patch.status].toLowerCase()}`);
    }
    if (!said.length) return false;

    await tx.update(chatRequests).set(changes).where(eq(chatRequests.id, r.id));
    const summary = said.join(", ");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "request",
      entityId: r.id,
      action: changes.status ? "status_change" : "update",
      summary: summary[0].toUpperCase() + summary.slice(1),
    });
    // The person hears when the status or the team's message changes, once per version.
    const status = changes.status ?? r.status;
    const text = changes.note ?? r.note;
    const tell =
      (changes.status || changes.note !== undefined) && (r.contact as ContactDetails).email;
    if (tell && emailConfigured()) {
      await enqueue(
        "send_request_update",
        { requestId: r.id },
        { tx, dedupeKey: updateKey(r.id, status, text), once: true },
      );
      return true;
    }
    return false;
  });
  if (emailed) await kickJobs();
}

/* ------------------------------------------------------------ the person */

export type RequestPage = {
  ref: string;
  typeName: string;
  botName: string;
  showName: string;
  status: RequestStatus;
  statusText: string;
  note: string;
  answers: RequestAnswer[];
  company: string;
  stand: string;
  createdAt: string;
  updatedAt: string;
};

/** What the person sees on their request's page: no email address or phone number. */
export async function requestByToken(token: string): Promise<RequestPage | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [r] = await db
    .select({ req: chatRequests, botName: bots.name, showName: bots.showName })
    .from(chatRequests)
    .innerJoin(bots, eq(bots.id, chatRequests.botId))
    .where(eq(chatRequests.trackToken, token))
    .limit(1);
  if (!r) return null;
  const contact = r.req.contact as ContactDetails;
  return {
    ref: requestRef(r.req.ref),
    typeName: r.req.typeName,
    botName: r.botName,
    showName: r.showName,
    status: r.req.status,
    statusText: REQUEST_STATUS_TEXT[r.req.status],
    note: r.req.note,
    answers: (r.req.answers as RequestAnswer[]).map((a) => ({ ...a, value: showValue(a.value) })),
    company: contact.company ?? "",
    stand: contact.stand ?? "",
    createdAt: r.req.createdAt.toISOString(),
    updatedAt: r.req.updatedAt.toISOString(),
  };
}

/* ----------------------------------------------------------------- jobs */

export function requestCard(r: {
  botName: string;
  ref: string;
  typeName: string;
  from: string;
  first: RequestAnswer | null;
  link: string;
}) {
  return adaptiveMessage({
    body: [
      plainLine(`${r.botName}: a new request`, { bold: true, size: "Medium", spacing: "None" }),
      plainLine(`${r.typeName} (${r.ref})`),
      plainLine(`From ${r.from}`),
      ...(r.first ? [plainLine(`${r.first.label}: ${r.first.value}`.slice(0, 300))] : []),
    ],
    actions: [{ type: "Action.OpenUrl", title: "Open in Billie", url: r.link }],
  });
}

/** The "notify_request" job: whoever handles it gets a Teams message; the event's channel a post. */
export async function notifyRequest(requestId: string): Promise<void> {
  const r = await db.query.chatRequests.findFirst({ where: eq(chatRequests.id, requestId) });
  if (!r) throw new PermanentJobError("Request not found");
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, r.botId) });
  if (!bot) return;
  // Test chats (Try a bot) don't message anyone: the tester sees it on the Requests page.
  const chat = r.conversationId
    ? await db.query.conversations.findFirst({
        where: eq(conversations.id, r.conversationId),
        columns: { channel: true },
      })
    : null;
  if (chat?.channel === "try") return;
  const answers = r.answers as RequestAnswer[];
  const card = requestCard({
    botName: bot.name,
    ref: requestRef(r.ref),
    typeName: r.typeName,
    from: requestFrom(r.contact as ContactDetails),
    first: answers[0] ? { ...answers[0], value: showValue(answers[0].value) } : null,
    link: `${appUrl()}/requests?r=${r.id}`,
  });
  const assignee = r.assignedTo
    ? await db.query.users.findFirst({
        where: and(eq(users.id, r.assignedTo), eq(users.status, "active")),
        columns: { email: true },
      })
    : null;
  const people = assignee ? [assignee] : await eventManager(bot.id);
  await queueDirect(people, `request:${r.id}`, cardOf(card));
  const channel = bot.teamsWebhookUrl?.trim();
  if (channel) await postToTeams(channel, card);
}

/** The "send_request_update" job: the person's email when their request changes. */
export async function sendRequestUpdate(requestId: string): Promise<void> {
  const r = await db.query.chatRequests.findFirst({ where: eq(chatRequests.id, requestId) });
  if (!r) throw new PermanentJobError("Request not found");
  const contact = r.contact as ContactDetails;
  if (!contact.email || !emailConfigured()) return;
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, r.botId) });
  const ref = requestRef(r.ref);
  const name = (contact.name ?? "").trim().split(/\s+/)[0];
  await sendEmail({
    to: contact.email,
    subject: `Your request ${ref}: ${REQUEST_STATUS_LABEL[r.status].toLowerCase()}`,
    text: [
      name ? `Hi ${name},` : "Hello,",
      "",
      REQUEST_STATUS_TEXT[r.status],
      ...(r.note ? ["", r.note] : []),
      "",
      `Request: ${r.typeName} (${ref})${bot?.showName ? `, ${bot.showName}` : ""}`,
      `Follow it here: ${appUrl()}/r/${r.trackToken}`,
    ].join("\n"),
  });
}
