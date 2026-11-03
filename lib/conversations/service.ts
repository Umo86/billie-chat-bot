import "server-only";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { botMailboxes, chatRequests, conversations, messages, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { answerQuestion, aiFailureLine } from "@/lib/ai/answer";
import { answerBotFor, type BotRow } from "@/lib/bots/load";
import { recordGap } from "@/lib/knowledge/gap-store";
import { hashToken, newToken } from "@/lib/chat/token";
import type { Actor } from "@/lib/authz";
import type {
  AnswerMeta,
  ContactDetails,
  ContactField,
  MessageSource,
  RequestAnswer,
  RequestOffer,
  RequestType,
} from "@/lib/types";
import { appUrl, emailConfigured } from "@/lib/config";
import { offerFor, requestRef } from "@/lib/requests/rules";
import {
  afterAnswer,
  afterRating,
  handoverLine,
  handoverRoute,
  type HandoverReason,
} from "./handover";
import { botPaused, nextStatus, type ConversationEvent, type ConversationStatus } from "./status";
import { agentsAvailable } from "./presence";
import { queueSuggestion } from "./suggest";

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
  };
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

async function view(rows: MessageRow[]): Promise<VisitorMessage[]> {
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

async function insertMessage(
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

  // 2. Billie answers.
  let answer;
  try {
    const answerBot = await answerBotFor(input.bot);
    answer = await answerQuestion({
      // WhatsApp can't show a form, so requests are only offered on the web.
      bot: input.channel === "whatsapp" ? { ...answerBot, requestTypes: [] } : answerBot,
      history,
      question: text,
      from: input.channel === "try" ? "staff" : "visitor",
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

  const offered = offerFor(input.bot.requestTypes, answer.request);
  const botRow = await db.transaction((tx) =>
    insertMessage(tx, convId, {
      role: "bot",
      text: answer.answer,
      sources: answer.sources,
      // The form offered is kept with the answer: it comes back if the page reloads.
      meta: offered ? { ...answer.meta, request: offered.typeId } : answer.meta,
    }),
  );
  out.messages.push(...(await view([botRow])));
  out.request = offered;

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
export async function handover(
  bot: BotRow,
  conversationId: string,
  reason: HandoverReason,
): Promise<Turn> {
  // Only people who work on this bot can see its chats.
  const route = handoverRoute(await agentsAvailable(new Date(), bot.id));
  const result = await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
    let status = await move(tx, c, route === "live" ? "handover_live" : "handover_offline");
    if (status === c.status) return { status, rows: [] as MessageRow[], changed: false };
    await tx
      .update(conversations)
      .set({ handoverReason: reason, handoverAt: new Date(), thumbsDownStreak: 0 })
      .where(eq(conversations.id, c.id));
    // WhatsApp already knows who they are: no details form, straight to a ticket.
    if (c.channel === "whatsapp" && status === "collecting") {
      status = await move(tx, { ...c, status }, "details_left");
      const line = await insertMessage(tx, c.id, {
        role: "system",
        text: `Nobody from the team is online right now. They'll reply here ${bot.rules.promise}.`,
      });
      await enqueue(
        "notify_handover",
        { conversationId: c.id, kind: "ticket" },
        { tx, dedupeKey: `notify:${c.id}:ticket` },
      );
      await queueSuggestion(tx, c.id);
      return { status, rows: [line], changed: true };
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
    // A suggested reply from the knowledge, ready for whoever picks it up.
    await queueSuggestion(tx, c.id);
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
    return [line];
  });
  await kickJobs();
  const c = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
  return {
    conversationId,
    status: c?.status ?? "bot",
    messages: await view(rows),
    offer: null,
    form: null,
    request: null,
  };
}

/** Thumbs up or down on one of Billie's answers; two downs in a row offers the team. */
export async function rateMessage(
  conversationId: string,
  messageId: string,
  rating: 1 | -1,
): Promise<{ offer: Turn["offer"] }> {
  const streak = await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
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
      .returning({ id: messages.id });
    if (!m) throw new ChatError("not_found", "That answer isn't in this chat.");
    const next = rating === -1 ? c.thumbsDownStreak + 1 : 0;
    await tx
      .update(conversations)
      .set({ thumbsDownStreak: next })
      .where(eq(conversations.id, c.id));
    return c.status === "bot" ? next : 0;
  });
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
  const pending =
    !after &&
    last?.role === "bot" &&
    conversation.status === "bot" &&
    conversation.channel !== "whatsapp"
      ? offerFor(bot.requestTypes, (last.meta as AnswerMeta).request ?? null)
      : null;
  return {
    conversationId: conversation.id,
    status: conversation.status,
    messages: await view(rows),
    offer: null,
    form: conversation.status === "collecting" ? formFor(bot) : null,
    request: pending,
  };
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

export async function staffReply(
  actor: Actor,
  conversationId: string,
  text: string,
): Promise<MessageRow> {
  const body = text.trim();
  if (!body) throw new ChatError("invalid", "Write a reply first.");
  if (body.length > 4000) throw new ChatError("invalid", "Keep replies under 4,000 characters.");
  const { row, followUp } = await db.transaction(async (tx) => {
    const c = await lock(tx, conversationId);
    const before = c.status;
    const status = await move(tx, c, "staff_replied");
    if (status === before && !["live", "replied"].includes(before)) {
      throw new ChatError("closed", "This chat is closed, so it can't take a reply.");
    }
    const row = await insertMessage(tx, c.id, { role: "agent", text: body, authorId: actor.id });
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
    const contact = c.contact as ContactDetails;
    const byEmail =
      (c.channel === "web" || c.channel === "hosted") &&
      Boolean(contact.email) &&
      ["ticket", "replied"].includes(status);
    const followUp = c.channel === "whatsapp" || byEmail;
    if (followUp) {
      await enqueue(
        "send_staff_reply",
        { messageId: row.id, via: c.channel === "whatsapp" ? "whatsapp" : "email" },
        { tx, dedupeKey: `reply:${row.id}` },
      );
    }
    return { row, followUp };
  });
  if (followUp) await kickJobs();
  return row;
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

export async function markRead(conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ staffReadAt: new Date() })
    .where(eq(conversations.id, conversationId));
}
