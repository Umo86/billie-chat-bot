import "server-only";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { botMailboxes, chatRequests, conversations, messages, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { forgetReused } from "@/lib/ai/reuse";
import { recordUnhelpful, withdrawUnhelpful } from "@/lib/knowledge/unhelpful";
import { answerQuestion, aiFailureLine } from "@/lib/ai/answer";
import { answerBotFor, botById, type BotRow } from "@/lib/bots/load";
import { slackConfigured } from "@/lib/channels/slack";
import { ticketReplyLine } from "@/lib/channels/slack-rules";
import { recordGap } from "@/lib/knowledge/gap-store";
import { hashToken, newToken } from "@/lib/chat/token";
import type { Actor } from "@/lib/authz";
import type {
  AnswerMeta,
  ChecklistItem,
  ContactDetails,
  ContactField,
  MessageSource,
  RequestAnswer,
  RequestOffer,
  RequestOrder,
  RequestType,
} from "@/lib/types";
import { stoppedLine, SUSPICIOUS_LIMIT } from "@/lib/chat/safety";
import { queueLead } from "@/lib/crm/leads";
import { appUrl, emailConfigured } from "@/lib/config";
import { offerFor, requestRef } from "@/lib/requests/rules";
import {
  afterAnswer,
  afterRating,
  contactComplete,
  handoverLine,
  handoverRoute,
  suggestStraightAway,
  WAIT_MINUTES,
  WAITED_LINE,
  type HandoverReason,
} from "./handover";
import { withinHours } from "./hours";
import { botPaused, nextStatus, type ConversationEvent, type ConversationStatus } from "./status";
import { queueSuggestion } from "./suggest";
import { exhibitorChecklist, knownFor, taskExhibitor, typesFor } from "@/lib/requests/tasks";
import { checklistText, hasToDo } from "@/lib/exhibitors/checklist";
import { londonDate } from "@/lib/time";
import { recordFor, signedInAs, signInWays } from "@/lib/exhibitors/service";
import { exhibitorsOnly, lockedLine } from "@/lib/chat/exhibitors-only";

/**
 * One conversation engine for every channel. Visitors' turns come from the
 * public chat API and the WhatsApp webhook; staff turns from the Inbox.
 * Every status change goes through the status machine inside a
 * transaction that locks the conversation row, so two people (or a person
 * and Billie) can't move the same chat in different directions at once.
 */
export type Channel = "web" | "hosted" | "whatsapp" | "try";
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export type VisitorMessage = {
  id: string;
  role: "visitor" | "bot" | "agent" | "system";
  text: string;
  sources: { title: string; label: string }[];
  author: string | null;
  rating: number | null;
  createdAt: string;
  /** The team's links, as buttons under Billie's answer. */
  links: { label: string; url: string }[];
};

export type Turn = {
  conversationId: string;
  status: ConversationStatus;
  /** Only when this turn created the chat (web, hosted, try). */
  token?: string;
  messages: VisitorMessage[];
  /** Show "Pass this to the team?" buttons. */
  offer: { reason: HandoverReason } | null;
  /** Show the details form (nobody online). */
  form: { fields: ContactField[]; promise: string } | null;
  /** Show a request form under Billie's answer (web and the chat page only). */
  request: RequestOffer | null;
  /** The exhibitor signed in to this chat, if any (lib/exhibitors/sign-in.ts). */
  signedIn?: { name: string; company: string; stand: string } | null;
  /**
   * What the signed-in exhibitor has to do before the show, while something
   * still is (lib/exhibitors/checklist.ts): deadlines ticked off, tasks as buttons.
   */
  checklist?: ChecklistItem[];
  /** Billie has stopped answering this chat (lib/chat/safety.ts): what to show instead. */
  stopped?: string;
  /** For signed-in exhibitors only, and they aren't (lib/chat/exhibitors-only.ts): how to sign in. */
  locked?: string;
};

export class ChatError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid" | "closed" | "not_allowed",
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export const MAX_MESSAGE = 2000;

function firstName(full: string | null | undefined): string | null {
  const f = (full ?? "").trim().split(/\s+/)[0];
  return f || null;
}

export function toVisitor(m: MessageRow, authorName?: string | null): VisitorMessage {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    sources: (m.sources as MessageSource[]).map((s) => ({ title: s.title, label: s.label })),
    author: m.role === "agent" ? firstName(authorName) : null,
    rating: m.rating,
    createdAt: m.createdAt.toISOString(),
    links: m.role === "bot" ? safeLinks((m.meta as AnswerMeta | null)?.links) : [],
  };
}

/** Links kept with a message, re-checked as http(s) before they reach the page. */
function safeLinks(links: unknown): { label: string; url: string }[] {
  if (!Array.isArray(links)) return [];
  return links
    .filter(
      (l): l is { label: string; url: string } =>
        Boolean(l) &&
        typeof l.label === "string" &&
        typeof l.url === "string" &&
        /^https?:\/\//i.test(l.url),
    )
    .slice(0, 2)
    .map((l) => ({ label: l.label.slice(0, 60), url: l.url.slice(0, 500) }));
}

async function authorNames(rows: MessageRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((m) => m.authorId).filter((x): x is string => Boolean(x)))];
  if (!ids.length) return new Map();
  const list = await db
    .select({ id: users.id, name: users.fullName })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(list.map((u) => [u.id, u.name]));
}

export async function view(rows: MessageRow[]): Promise<VisitorMessage[]> {
  const names = await authorNames(rows);
  return rows.map((m) => toVisitor(m, m.authorId ? names.get(m.authorId) : null));
}

function formFor(bot: BotRow): Turn["form"] {
  return { fields: bot.rules.collect, promise: bot.rules.promise };
}

async function lock(tx: Tx, id: string): Promise<ConversationRow> {
  const rows = await tx.select().from(conversations).where(eq(conversations.id, id)).for("update");
  if (!rows[0]) throw new ChatError("not_found", "This chat has ended. Start a new one.");
  return rows[0];
}

export async function insertMessage(
  tx: Tx,
  conversationId: string,
  values: Omit<typeof messages.$inferInsert, "conversationId">,
): Promise<MessageRow> {
  const [m] = await tx
    .insert(messages)
    .values({ conversationId, ...values })
    .returning();
  await tx
    .update(conversations)
    .set({
      messageCount: sql`${conversations.messageCount} + 1`,
      lastMessageAt: m.createdAt,
      ...(values.role === "visitor" || values.role === "bot" || values.role === "agent"
        ? { lastText: values.text.slice(0, 300) }
        : {}),
    })
    .where(eq(conversations.id, conversationId));
  return m;
}

async function move(
  tx: Tx,
  conv: ConversationRow,
  event: ConversationEvent,
): Promise<ConversationStatus> {
  const to = nextStatus(conv.status, event);
  if (!to) return conv.status;
  if (to !== conv.status) {
    await tx
      .update(conversations)
      .set({ status: to, ...(to === "closed" ? { closedAt: new Date() } : {}) })
      .where(eq(conversations.id, conv.id));
  }
  return to;
}

/** A visitor's chat (web, hosted, try) by its token, or null. */
export async function conversationForToken(
  token: string,
  botId: string,
): Promise<ConversationRow | null> {
  const row = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.visitorTokenHash, hashToken(token)),
      eq(conversations.botId, botId),
    ),
  });
  return row ?? null;
}

export async function startConversation(input: {
  bot: BotRow;
  channel: Channel;
  pageUrl?: string | null;
  waId?: string | null;
}): Promise<{ conversation: ConversationRow; token: string | null }> {
  const token = input.channel === "whatsapp" ? null : newToken();
  const [conversation] = await db
    .insert(conversations)
    .values({
      botId: input.bot.id,
      channel: input.channel,
      visitorTokenHash: token ? hashToken(token) : null,
      waId: input.waId ?? null,
      pageUrl: input.pageUrl?.slice(0, 500) ?? null,
    })
    .returning();
  return { conversation, token };
}

/** A visitor's message, and Billie's reply unless a person has the chat. */
export async function visitorMessage(input: {
  bot: BotRow;
  conversation: ConversationRow | null;
  channel: Channel;
  text: string;
  pageUrl?: string | null;
  waId?: string | null;
  externalId?: string | null;
}): Promise<Turn> {
  const text = input.text.trim();
  if (!text) throw new ChatError("invalid", "Type a message first.");
  if (text.length > MAX_MESSAGE)
    throw new ChatError("invalid", "That message is too long. Keep it under 2,000 characters.");

  let token: string | undefined;
  let conv = input.conversation;
  if (!conv) {
    const started = await startConversation(input);
    conv = started.conversation;
    token = started.token ?? undefined;
  }
  const convId = conv.id;

  // 1. Record the message and let the status machine react to it.
  const { visitorRow, status, history } = await db.transaction(async (tx) => {
    const c = await lock(tx, convId);
    const visitorRow = await insertMessage(tx, c.id, {
      role: "visitor",
      text,
      externalId: input.externalId ?? null,
    });
    await tx
      .update(conversations)
      .set({
        lastVisitorAt: visitorRow.createdAt,
        ...(c.firstQuestion ? {} : { firstQuestion: text.slice(0, 300) }),
      })
      .where(eq(conversations.id, c.id));
    const status = await move(tx, c, "visitor_wrote");
    // A person has the chat: what they write goes to its Slack thread too.
    if (botPaused(status) && slackConfigured())
      await enqueue(
        "slack_relay",
        { messageId: visitorRow.id },
        { tx, dedupeKey: `slack-relay:${visitorRow.id}` },
      );
    const earlier = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, c.id), sql`${messages.id} <> ${visitorRow.id}`))
      .orderBy(desc(messages.createdAt))
      .limit(12);
    return {
      visitorRow,
      status,
      history: earlier.reverse().map((m) => ({ role: m.role, text: m.text })),
    };
  });

  const out: Turn = {
    conversationId: convId,
    status,
    token,
    messages: await view([visitorRow]),
    offer: null,
    form: status === "collecting" ? formFor(input.bot) : null,
    request: null,
  };
  if (botPaused(status)) return out; // A person has this chat; the Inbox shows the new message.

  // A chat Billie stopped answering (suspicious messages) gets the same line, without Claude.
  if (conv.flags >= SUSPICIOUS_LIMIT) {
    const line = stoppedLine(input.bot.contactEmail);
    const row = await db.transaction((tx) =>
      insertMessage(tx, convId, { role: "bot", text: line, meta: { flag: "suspicious" } }),
    );
    out.messages.push(...(await view([row])));
    out.stopped = line;
    return out;
  }

  // 2. Billie answers.
  let answer;
  // Requests for some stands only (a task for space only stands) are only offered to them.
  const chatRow = await db.query.conversations.findFirst({
    where: eq(conversations.id, convId),
    columns: { exhibitorId: true, signedInAt: true, signedInEmail: true },
  });
  const exhibitor = chatRow && input.channel !== "whatsapp" ? await taskExhibitor(chatRow) : null;
  // For signed-in exhibitors only (Exhibitors step): anyone else is told how to sign in, and
  // Claude isn't asked. On WhatsApp nobody can sign in, so it's the manual or the team's email.
  if (input.channel !== "try" && exhibitorsOnly(input.bot) && !exhibitor) {
    const line = lockedLine(
      await signInWays(input.bot),
      input.bot.contactEmail,
      input.channel === "whatsapp",
    );
    const row = await db.transaction((tx) =>
      insertMessage(tx, convId, { role: "bot", text: line, meta: { locked: true } }),
    );
    out.messages.push(...(await view([row])));
    out.locked = line;
    return out;
  }
  try {
    const answerBot = await answerBotFor(input.bot);
    const person =
      answerBot.personal && input.channel !== "whatsapp"
        ? await signedInRecord(input.bot, convId, exhibitor)
        : null;
    answer = await answerQuestion({
      // WhatsApp can't show a form, or sign anyone in: both are only on the web.
      bot:
        input.channel === "whatsapp"
          ? { ...answerBot, requestTypes: [], personal: false, links: [] }
          : { ...answerBot, requestTypes: typesFor(input.bot, exhibitor) },
      history,
      question: text,
      from: input.channel === "try" ? "staff" : "visitor",
      person,
      // Visitors only: tests and the try page always ask Claude.
      reuse: input.channel === "try" ? null : input.channel === "whatsapp" ? "whatsapp" : "web",
    });
  } catch (err) {
    console.error("answer failed", err instanceof Error ? `${err.name}: ${err.message}` : err);
    const failed = await db.transaction((tx) =>
      insertMessage(tx, convId, {
        role: "bot",
        text: `${aiFailureLine(err)} I can pass your question to the team.`,
        meta: { error: err instanceof Error ? err.message.slice(0, 200) : "unknown" },
      }),
    );
    out.messages.push(...(await view([failed])));
    out.offer = { reason: "ai_unavailable" };
    return out;
  }

  const offered = offerFor(
    typesFor(input.bot, exhibitor),
    answer.request,
    input.bot.audience,
    knownFor(exhibitor, chatRow?.signedInEmail ?? null),
  );
  const links =
    input.channel === "whatsapp" ? [] : answer.links.map((l) => ({ label: l.label, url: l.url }));
  const { botRow, flags } = await db.transaction(async (tx) => {
    const botRow = await insertMessage(tx, convId, {
      role: "bot",
      text: answer.answer,
      sources: answer.sources,
      // The form offered and the links are kept with the answer: they come back on reload.
      meta: {
        ...answer.meta,
        ...(offered ? { request: offered.typeId } : {}),
        ...(links.length ? { links } : {}),
      },
    });
    if (answer.flag !== "suspicious") return { botRow, flags: 0 };
    const [c] = await tx
      .update(conversations)
      .set({ flags: sql`${conversations.flags} + 1` })
      .where(eq(conversations.id, convId))
      .returning({ flags: conversations.flags });
    return { botRow, flags: c?.flags ?? 0 };
  });
  out.messages.push(...(await view([botRow])));
  out.request = offered;
  if (flags >= SUSPICIOUS_LIMIT) {
    out.stopped = stoppedLine(input.bot.contactEmail);
    return out;
  }

  const decision = afterAnswer(answer.handover);
  if (out.request) {
    // They're making a request: the form is the next step, not the team.
  } else if (decision.kind === "offer") {
    await recordGap(input.bot.id, text);
    out.offer = { reason: decision.reason };
  } else if (decision.kind === "now") {
    const h = await handover(input.bot, convId, decision.reason);
    out.status = h.status;
    out.messages.push(...h.messages);
    out.form = h.form;
  }
  return out;
}

/** Pass the chat to the team: live if someone is available, otherwise take details. */
/**
 * Straight to a ticket, with no details form, when Billie already knows who
 * they are: on WhatsApp, or signed in from the exhibitor manual.
 */
async function ticketWithoutForm(
  tx: Tx,
  bot: BotRow,
  c: ConversationRow,
  opening: string,
): Promise<{ status: ConversationStatus; line: MessageRow } | null> {
  const contact = c.contact as ContactDetails;
  if (c.channel !== "whatsapp" && !contactComplete(bot.rules.collect, contact)) return null;
  const status = await move(tx, c, "details_left");
  if (status !== "ticket") return null;
  const where =
    c.channel === "whatsapp" ? "here" : contact.email ? `by email at ${contact.email}` : "";
  const line = await insertMessage(tx, c.id, {
    role: "system",
    text: `${opening} They'll reply ${where ? `${where} ` : ""}${bot.rules.promise}.`,
  });
  await enqueue(
    "notify_handover",
    { conversationId: c.id, kind: "ticket" },
    { tx, dedupeKey: `notify:${c.id}:ticket` },
  );
  return { status, line };
}

export async function handover(
  bot: BotRow,
  conversationId: string,
  reason: HandoverReason,
  now = new Date(),
): Promise<Turn> {
  // Live during the bot's working hours; outside them, their details for a ticket.
  const route = handoverRoute(withinHours(bot.rules.hours, now));
  const result = await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
    let status = await move(tx, c, route === "live" ? "handover_live" : "handover_offline");
    if (status === c.status) return { status, rows: [] as MessageRow[], changed: false };
    await tx
      .update(conversations)
      .set({ handoverReason: reason, handoverAt: now, thumbsDownStreak: 0 })
      .where(eq(conversations.id, c.id));
    if (status === "collecting") {
      const ticket = await ticketWithoutForm(
        tx,
        bot,
        { ...c, status },
        "Nobody from the team is online right now.",
      );
      if (ticket) {
        status = ticket.status;
        if (suggestStraightAway(reason)) await queueSuggestion(tx, c.id);
        return { status, rows: [ticket.line], changed: true };
      }
    }
    const line = await insertMessage(tx, c.id, {
      role: "system",
      text: handoverLine(route, reason),
    });
    await writeAudit(tx, {
      actorType: "visitor",
      entityType: "conversation",
      entityId: c.id,
      action: "handover",
      summary: `Chat with ${bot.name} handed to the team (${route === "live" ? "live" : "details"}, ${reason})`,
    });
    if (route === "live") {
      await enqueue(
        "notify_handover",
        { conversationId: c.id, kind: "live" },
        { tx, dedupeKey: `notify:${c.id}:live` },
      );
    }
    // A suggested reply from the knowledge, ready for whoever picks it up (when it can help).
    if (suggestStraightAway(reason)) await queueSuggestion(tx, c.id);
    return { status, rows: [line], changed: true };
  });
  if (result.changed) await kickJobs();
  return {
    conversationId,
    status: result.status,
    messages: await view(result.rows),
    offer: null,
    form: result.status === "collecting" ? formFor(bot) : null,
    request: null,
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Checks and tidies what the person typed into the details form. */
export function cleanContact(
  fields: ContactField[],
  input: Partial<Record<ContactField, unknown>>,
): { contact: ContactDetails; errors: Partial<Record<ContactField, string>> } {
  const contact: ContactDetails = {};
  const errors: Partial<Record<ContactField, string>> = {};
  for (const f of fields) {
    const v = String(input[f] ?? "")
      .trim()
      .slice(0, 200);
    if (v) contact[f] = v;
  }
  if (fields.includes("name") && !contact.name) errors.name = "Add your name.";
  if (fields.includes("email")) {
    if (!contact.email) errors.email = "Add your email so the team can reply.";
    else if (!EMAIL.test(contact.email)) errors.email = "That email doesn't look right.";
  }
  if (contact.phone && !/^[+()\d\s-]{6,25}$/.test(contact.phone))
    errors.phone = "That phone number doesn't look right.";
  return { contact, errors };
}

export async function submitDetails(
  bot: BotRow,
  conversationId: string,
  contact: ContactDetails,
): Promise<Turn> {
  const rows = await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
    const status = await move(tx, c, "details_left");
    if (status !== "ticket") throw new ChatError("invalid", "This chat isn't waiting for details.");
    await tx
      .update(conversations)
      .set({ contact: { ...(c.contact as ContactDetails), ...contact } })
      .where(eq(conversations.id, c.id));
    const name = firstName(contact.name);
    const line = await insertMessage(tx, c.id, {
      role: "system",
      text: `Thanks${name ? `, ${name}` : ""}. The team will reply ${bot.rules.promise}.`,
    });
    await enqueue(
      "notify_handover",
      { conversationId: c.id, kind: "ticket" },
      { tx, dedupeKey: `notify:${c.id}:ticket` },
    );
    return [line];
  });
  await kickJobs();
  return {
    conversationId,
    status: "ticket",
    messages: await view(rows),
    offer: null,
    form: null,
    request: null,
  };
}

export async function cancelDetails(conversationId: string): Promise<Turn> {
  const { status, rows } = await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
    const status = await move(tx, c, "form_cancelled");
    if (status === c.status) return { status, rows: [] as MessageRow[] };
    const line = await insertMessage(tx, c.id, {
      role: "system",
      text: "No problem. Ask me anything else.",
    });
    return { status, rows: [line] };
  });
  return {
    conversationId,
    status,
    messages: await view(rows),
    offer: null,
    form: null,
    request: null,
  };
}

/** Who handles a new request: its own handler, else whoever manages the bot's event mailbox. */
async function requestHandler(tx: Tx, botId: string, type: RequestType): Promise<string | null> {
  const ids = [type.handlerId].filter((x): x is string => Boolean(x));
  const [box] = await tx
    .select({ userId: botMailboxes.assignedUserId })
    .from(botMailboxes)
    .where(eq(botMailboxes.botId, botId))
    .limit(1);
  if (box?.userId) ids.push(box.userId);
  for (const id of ids) {
    const u = await tx.query.users.findFirst({
      where: and(eq(users.id, id), eq(users.status, "active")),
      columns: { id: true },
    });
    if (u) return u.id;
  }
  return null;
}

/**
 * A request from the chat's form: saved with who handles it, the person's
 * details added to the chat, a line in the chat with their reference and
 * the link to follow it, and the team told (the "notify_request" job).
 * Pressing Send twice gives one request.
 */
export async function submitRequest(
  bot: BotRow,
  conversationId: string,
  type: RequestType,
  answers: RequestAnswer[],
  contact: ContactDetails,
  extra: { order?: RequestOrder | null; exhibitorId?: string | null } = {},
): Promise<Turn> {
  const rows = await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
    if (c.status === "closed")
      throw new ChatError("closed", "This chat has ended. Start a new one.");
    const [recent] = await tx
      .select({ ref: chatRequests.ref })
      .from(chatRequests)
      .where(
        and(
          eq(chatRequests.conversationId, c.id),
          eq(chatRequests.typeId, type.id),
          sql`${chatRequests.answers} = ${JSON.stringify(answers)}::jsonb`,
          sql`${chatRequests.createdAt} > now() - interval '10 minutes'`,
        ),
      )
      .limit(1);
    if (recent) {
      const line = await insertMessage(tx, c.id, {
        role: "system",
        text: `Your request ${requestRef(recent.ref)} is already with the team.`,
      });
      return [line];
    }
    const trackToken = newToken();
    const [req] = await tx
      .insert(chatRequests)
      .values({
        botId: bot.id,
        conversationId: c.id,
        typeId: type.id,
        typeName: type.name,
        answers,
        contact,
        assignedTo: await requestHandler(tx, bot.id, type),
        trackToken,
        exhibitorId: extra.exhibitorId ?? null,
        order: extra.order ?? null,
      })
      .returning({ id: chatRequests.id, ref: chatRequests.ref });
    await tx
      .update(conversations)
      .set({ contact: { ...(c.contact as ContactDetails), ...contact } })
      .where(eq(conversations.id, c.id));
    const name = firstName(contact.name);
    const line = await insertMessage(tx, c.id, {
      role: "system",
      text: [
        `Thanks${name ? `, ${name}` : ""}. Your request ${requestRef(req.ref)} (${type.name}) is with the team.`,
        emailConfigured() ? "You'll get an email when it changes." : "",
        `Follow it here: ${appUrl()}/r/${trackToken}`,
      ]
        .filter(Boolean)
        .join(" "),
    });
    await writeAudit(tx, {
      actorType: "visitor",
      entityType: "request",
      entityId: req.id,
      action: "create",
      summary: `New request ${requestRef(req.ref)} (${type.name}) in a chat with ${bot.name}`,
    });
    await enqueue(
      "notify_request",
      { requestId: req.id },
      { tx, dedupeKey: `notify-request:${req.id}` },
    );
    // A lead (e.g. interested in exhibiting): to Twenty CRM too.
    if (type.crm) await queueLead(tx, req.id);
    return [line];
  });
  await kickJobs();
  const c = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
  // A task done: the rest of the exhibitor's list, while something is still to do.
  const checklist =
    c && type.task && c.status === "bot"
      ? await exhibitorChecklist(bot, await taskExhibitor(c))
      : [];
  return {
    conversationId,
    status: c?.status ?? "bot",
    messages: await view(rows),
    offer: null,
    form: null,
    request: null,
    ...(hasToDo(checklist) ? { checklist } : {}),
  };
}

/** Thumbs up or down on one of Billie's answers; two downs in a row offers the team. */
export async function rateMessage(
  conversationId: string,
  messageId: string,
  rating: 1 | -1,
): Promise<{ offer: Turn["offer"] }> {
  const { streak, rated, was } = await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
    const before = await tx.query.messages.findFirst({
      where: and(
        eq(messages.id, messageId),
        eq(messages.conversationId, c.id),
        eq(messages.role, "bot"),
      ),
      columns: { rating: true },
    });
    const [m] = await tx
      .update(messages)
      .set({ rating })
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.conversationId, c.id),
          eq(messages.role, "bot"),
        ),
      )
      .returning({ id: messages.id, text: messages.text, createdAt: messages.createdAt });
    if (!m) throw new ChatError("not_found", "That answer isn't in this chat.");
    // Nobody else gets an unhelpful answer again without Claude.
    if (rating === -1) await forgetReused(c.botId, m.text);
    const next = rating === -1 ? c.thumbsDownStreak + 1 : 0;
    await tx
      .update(conversations)
      .set({ thumbsDownStreak: next })
      .where(eq(conversations.id, c.id));
    return {
      streak: c.status === "bot" ? next : 0,
      rated: { botId: c.botId, conversationId: c.id, answer: m.text, answeredAt: m.createdAt },
      was: before?.rating ?? null,
    };
  });
  // It goes on the Knowledge page for the team to fix: once per answer, and a
  // change of mind takes it back. (The row lock above keeps double taps apart.)
  if (rating === -1 && was !== -1) await recordUnhelpful(rated);
  if (rating === 1 && was === -1) await withdrawUnhelpful(rated);
  const decision = afterRating(streak);
  return { offer: decision.kind === "offer" ? { reason: decision.reason } : null };
}

/** New messages for the visitor since `after` (the chat polls this while a person has it). */
export async function visitorUpdates(
  bot: BotRow,
  conversation: ConversationRow,
  after: Date | null,
): Promise<Turn> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      after
        ? and(eq(messages.conversationId, conversation.id), gt(messages.createdAt, after))
        : eq(messages.conversationId, conversation.id),
    )
    .orderBy(asc(messages.createdAt))
    .limit(200);
  // Opening the chat again (a reload, or the next page of the website): a form Billie
  // offered in its last message, with nothing said since, is shown again.
  const last = rows.at(-1);
  const exhibitor =
    !after && conversation.channel !== "whatsapp" ? await taskExhibitor(conversation) : null;
  const pending =
    !after &&
    last?.role === "bot" &&
    conversation.status === "bot" &&
    conversation.channel !== "whatsapp"
      ? offerFor(
          typesFor(bot, exhibitor),
          (last.meta as AnswerMeta).request ?? null,
          bot.audience,
          knownFor(exhibitor, conversation.signedInEmail),
        )
      : null;
  // Signed in, with nothing else on screen: what they still have to do before the show.
  const checklist =
    !after && !pending && conversation.status === "bot"
      ? await exhibitorChecklist(bot, exhibitor)
      : [];
  return {
    conversationId: conversation.id,
    status: conversation.status,
    messages: await view(rows),
    offer: null,
    form: conversation.status === "collecting" ? formFor(bot) : null,
    request: pending,
    signedIn: after ? undefined : await signedInAs(conversation),
    ...(hasToDo(checklist) ? { checklist } : {}),
    ...(conversation.flags >= SUSPICIOUS_LIMIT ? { stopped: stoppedLine(bot.contactEmail) } : {}),
  };
}

/**
 * A signed-in exhibitor pressed one of their tasks: its form, with what
 * Billie already knows filled in. No Claude call. Only a task that's for
 * their stand; kept with a line from Billie, so the form can be sent.
 */
export async function startTask(
  bot: BotRow,
  conversationId: string,
  typeId: string,
): Promise<Turn> {
  const c = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
  if (!c || c.status === "closed")
    throw new ChatError("closed", "This chat has ended. Start a new one.");
  if (c.status !== "bot")
    throw new ChatError("invalid", "The team has this chat now: ask them here instead.");
  const exhibitor = await taskExhibitor(c);
  const type = typesFor(bot, exhibitor).find((t) => t.id === typeId && t.task);
  if (!type || !exhibitor)
    throw new ChatError("not_found", "That task isn't available any more. Ask Billie instead.");
  const row = await db.transaction((tx) =>
    insertMessage(tx, c.id, {
      role: "bot",
      text: type.items?.length
        ? `Here's the ${type.name} form. Choose how many of each, then send it: the total shows as you go.`
        : `Here's the ${type.name} form. Fill it in, then send it.`,
      meta: { request: type.id } as AnswerMeta,
    }),
  );
  return {
    conversationId: c.id,
    status: c.status,
    messages: await view([row]),
    offer: null,
    form: null,
    request: offerFor([type], type.id, bot.audience, knownFor(exhibitor, c.signedInEmail)),
  };
}

/** The signed-in exhibitor's record for Billie to answer from (none if nobody is). */
async function signedInRecord(
  bot: BotRow,
  conversationId: string,
  exhibitor: Awaited<ReturnType<typeof taskExhibitor>>,
): Promise<{ record: string } | null> {
  const c = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { exhibitorId: true, signedInAt: true, signedInEmail: true },
  });
  const record = c ? await recordFor(c) : null;
  if (!record) return null;
  // What they still have to do, so "what's left for us to do?" gets a true answer.
  const list = checklistText(await exhibitorChecklist(bot, exhibitor), londonDate());
  return { record: list ? `${record}\n\n${list}` : record };
}

/** Whether Billie offered this request's form in this chat (the only way to send one). */
export async function requestOffered(conversationId: string, typeId: string): Promise<boolean> {
  const [m] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "bot"),
        sql`${messages.meta}->>'request' = ${typeId}`,
      ),
    )
    .limit(1);
  return Boolean(m);
}

/* ------------------------------------------------------------- staff side */

/**
 * A reply from the team. `via` says how it reaches them: in the chat now, or
 * by WhatsApp or email (a job). With `externalId` (a reply written in Slack)
 * the same reply is only ever taken once, however often its job runs.
 */
export async function staffReply(
  actor: Actor,
  conversationId: string,
  text: string,
  opts: { fromSlack?: boolean; externalId?: string } = {},
): Promise<{ message: MessageRow; via: "chat" | "whatsapp" | "email" }> {
  const body = text.trim();
  if (!body) throw new ChatError("invalid", "Write a reply first.");
  if (body.length > 4000) throw new ChatError("invalid", "Keep replies under 4,000 characters.");
  const { row, followUp, via } = await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
    const viaOf = (status: ConversationStatus): "chat" | "whatsapp" | "email" => {
      if (c.channel === "whatsapp") return "whatsapp";
      const contact = c.contact as ContactDetails;
      return (c.channel === "web" || c.channel === "hosted") &&
        Boolean(contact.email) &&
        ["ticket", "replied"].includes(status)
        ? "email"
        : "chat";
    };
    if (opts.externalId) {
      const [taken] = await tx
        .select()
        .from(messages)
        .where(eq(messages.externalId, opts.externalId))
        .limit(1);
      if (taken) return { row: taken, followUp: false, via: viaOf(c.status) };
    }
    const before = c.status;
    const status = await move(tx, c, "staff_replied");
    if (status === before && !["live", "replied"].includes(before)) {
      throw new ChatError("closed", "This chat is closed, so it can't take a reply.");
    }
    const row = await insertMessage(tx, c.id, {
      role: "agent",
      text: body,
      authorId: actor.id,
      externalId: opts.externalId ?? null,
    });
    await tx
      .update(conversations)
      .set({ assignedTo: c.assignedTo ?? actor.id, staffReadAt: new Date() })
      .where(eq(conversations.id, c.id));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "conversation",
      entityId: c.id,
      action: "reply",
      summary: "Replied in a chat",
    });
    // Replies go back the way the question came: WhatsApp, or email when the person left details.
    const via = viaOf(status);
    const followUp = via !== "chat";
    // Written in Billie's Inbox: the chat's Slack thread shows it too.
    if (!opts.fromSlack && slackConfigured())
      await enqueue(
        "slack_relay",
        { messageId: row.id },
        { tx, dedupeKey: `slack-relay:${row.id}` },
      );
    if (followUp) {
      await enqueue(
        "send_staff_reply",
        { messageId: row.id, via: c.channel === "whatsapp" ? "whatsapp" : "email" },
        { tx, dedupeKey: `reply:${row.id}` },
      );
    }
    return { row, followUp, via };
  });
  if (followUp) await kickJobs();
  return { message: row, via };
}

export async function handBack(actor: Actor, conversationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
    const status = await move(tx, c, "hand_back");
    if (status === c.status)
      throw new ChatError("invalid", "Only a waiting or live chat can go back to Billie.");
    await insertMessage(tx, c.id, {
      role: "system",
      text: "You're back with Billie. Ask me anything.",
    });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "conversation",
      entityId: c.id,
      action: "status_change",
      summary: "Handed a chat back to Billie",
    });
  });
}

export async function closeConversation(actor: Actor, conversationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
    const status = await move(tx, c, "close");
    if (status === c.status) return;
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "conversation",
      entityId: c.id,
      action: "status_change",
      summary: "Closed a chat",
    });
  });
}

/** Is any live chat still waiting for the team after WAIT_MINUTES? (A cheap look, every minute.) */
export async function hasExpiredWaiting(now = new Date()): Promise<boolean> {
  const cutoff = new Date(now.getTime() - WAIT_MINUTES * 60_000);
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.status, "waiting"), lt(conversations.handoverAt, cutoff)))
    .limit(1);
  return Boolean(row);
}

/**
 * Live chats nobody from the team has answered in WAIT_MINUTES: Billie asks
 * for the person's details instead (or, knowing who they are, makes it a
 * ticket), so nobody waits on a chat no one is watching. Every minute.
 */
export async function expireWaiting(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - WAIT_MINUTES * 60_000);
  const due = await db
    .select({ id: conversations.id, botId: conversations.botId })
    .from(conversations)
    .where(and(eq(conversations.status, "waiting"), lt(conversations.handoverAt, cutoff)))
    .limit(100);
  let moved = 0;
  for (const d of due) {
    const bot = await botById(d.botId);
    if (!bot) continue;
    const changed = await db.transaction(async (tx) => {
      const c = await lock(tx, d.id);
      if (c.status !== "waiting" || !c.handoverAt || c.handoverAt >= cutoff) return false;
      const status = await move(tx, c, "handover_offline");
      if (status !== "collecting") return false;
      const ticket = await ticketWithoutForm(
        tx,
        bot,
        { ...c, status },
        "Sorry, nobody from the team is free right now.",
      );
      if (!ticket) await insertMessage(tx, c.id, { role: "system", text: WAITED_LINE });
      // WhatsApp only hears what's sent to it: the chat page and widget show the line themselves.
      if (ticket && c.channel === "whatsapp")
        await enqueue(
          "send_staff_reply",
          { messageId: ticket.line.id, via: "whatsapp" },
          { tx, dedupeKey: `reply:${ticket.line.id}` },
        );
      await writeAudit(tx, {
        actorType: "system",
        entityType: "conversation",
        entityId: c.id,
        action: "status_change",
        summary: `Nobody answered a chat with ${bot.name} within ${WAIT_MINUTES} minutes: ${ticket ? "made it a ticket" : "asked for their details"}`,
      });
      if (slackConfigured())
        await enqueue(
          "slack_note",
          {
            conversationId: c.id,
            text: ticket
              ? `Nobody answered within ${WAIT_MINUTES} minutes, so Billie made it a ticket. ${ticketReplyLine(
                  { channel: c.channel, email: (c.contact as ContactDetails).email },
                  emailConfigured(),
                )}`
              : `Nobody answered within ${WAIT_MINUTES} minutes, so Billie is asking for their details.`,
          },
          { tx, dedupeKey: `slack-waited:${c.id}:${c.handoverAt.getTime()}` },
        );
      return true;
    });
    if (changed) moved++;
  }
  if (moved) await kickJobs();
  return moved;
}

export async function markRead(conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ staffReadAt: new Date() })
    .where(eq(conversations.id, conversationId));
}
