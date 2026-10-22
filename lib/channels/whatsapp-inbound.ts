import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { conversations, messages, whatsappContacts } from "@/lib/db/schema";
import { botById } from "@/lib/bots/load";
import { getSettings } from "@/lib/settings";
import { visitorMessage, type ConversationRow } from "@/lib/conversations/service";
import { allow, LIMITS } from "@/lib/rate-limit";
import { formatAnswer, sendButtons, sendText, type InboundMessage } from "./whatsapp";

/**
 * Handling one WhatsApp message (the "whatsapp_inbound" job, so the webhook
 * answers Meta at once). First contact asks "Visiting or exhibiting?" and
 * keeps the question until they choose; after that the chosen bot answers,
 * and Billie's reply, any handover line and the details request go back as
 * WhatsApp messages. A message already handled (Meta retries, or this job
 * retrying after a failed send) only resends what didn't go out: each reply
 * records the WhatsApp id it was sent as.
 */
const ROUTE_PROMPT = "Hi! Are you visiting the show or exhibiting at it?";
const CHOICES = [
  { id: "visitor", title: "Visiting" },
  { id: "exhibitor", title: "Exhibiting" },
];
/** Over this long since the last message, a chat starts afresh. */
const NEW_CHAT_AFTER_MS = 7 * 86_400_000;

async function openConversation(waId: string, botId: string): Promise<ConversationRow | null> {
  const row = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.waId, waId),
      eq(conversations.botId, botId),
      ne(conversations.status, "closed"),
    ),
    orderBy: desc(conversations.lastMessageAt),
  });
  if (!row) return null;
  return Date.now() - row.lastMessageAt.getTime() > NEW_CHAT_AFTER_MS ? null : row;
}

type Outgoing = {
  id: string;
  role: string;
  text: string;
  sources: { title: string; label: string }[];
};

/** Sends replies in order, marking each as sent (its WhatsApp id) so a retry won't repeat it. */
async function deliver(to: string, rows: Outgoing[]): Promise<void> {
  for (const r of rows) {
    const sentId = await sendText(to, r.role === "bot" ? formatAnswer(r.text, r.sources) : r.text);
    if (sentId)
      await db
        .update(messages)
        .set({ externalId: sentId })
        .where(and(eq(messages.id, r.id), isNull(messages.externalId)));
  }
}

/** For a message already recorded: the replies after it that never went out. */
async function unsentAfter(messageId: string): Promise<Outgoing[] | null> {
  const visitor = await db.query.messages.findFirst({
    where: eq(messages.externalId, messageId),
    columns: { conversationId: true, createdAt: true },
  });
  if (!visitor) return null;
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      text: messages.text,
      sources: messages.sources,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, visitor.conversationId),
        gt(messages.createdAt, visitor.createdAt),
        inArray(messages.role, ["bot", "system"]),
        isNull(messages.externalId),
      ),
    )
    .orderBy(asc(messages.createdAt));
  return rows.map((r) => ({ ...r, sources: r.sources as Outgoing["sources"] }));
}

export async function handleWhatsAppInbound(m: InboundMessage): Promise<void> {
  const unsent = await unsentAfter(m.id);
  if (unsent) {
    await deliver(m.from, unsent);
    return;
  }
  // One sender can't run up the answer budget.
  if (
    !(await allow(`wa:${m.from}`, LIMITS.whatsappSender)) ||
    !(await allow(`wa:day:${m.from}`, LIMITS.whatsappSenderDaily))
  )
    return;
  const settings = await getSettings();
  const visitorBot = settings.whatsappVisitorBotId
    ? await botById(settings.whatsappVisitorBotId)
    : null;
  const exhibitorBot = settings.whatsappExhibitorBotId
    ? await botById(settings.whatsappExhibitorBotId)
    : null;
  const live = [visitorBot, exhibitorBot].filter((b) => b && b.status === "live");
  if (!live.length) {
    await sendText(m.from, "Sorry, this number isn't answering questions yet.");
    return;
  }

  await db
    .insert(whatsappContacts)
    .values({ waId: m.from, profileName: m.profileName.slice(0, 120), lastInboundAt: m.timestamp })
    .onConflictDoUpdate({
      target: whatsappContacts.waId,
      set: { profileName: m.profileName.slice(0, 120), lastInboundAt: m.timestamp },
    });
  const contact = await db.query.whatsappContacts.findFirst({
    where: eq(whatsappContacts.waId, m.from),
  });

  // Which bot? A tapped button decides; otherwise their earlier choice; otherwise ask.
  let bot = null as typeof visitorBot;
  let question = m.text;
  if (m.buttonId === "visitor" || m.buttonId === "exhibitor") {
    bot = m.buttonId === "visitor" ? visitorBot : exhibitorBot;
    question = contact?.pendingText ?? "";
    await db
      .update(whatsappContacts)
      .set({ botId: bot?.id ?? null, pendingText: null })
      .where(eq(whatsappContacts.waId, m.from));
  } else if (live.length === 1) {
    bot = live[0];
  } else if (contact?.botId && [visitorBot?.id, exhibitorBot?.id].includes(contact.botId)) {
    bot = contact.botId === visitorBot?.id ? visitorBot : exhibitorBot;
  } else {
    await db
      .update(whatsappContacts)
      .set({ pendingText: m.text.slice(0, 2000) })
      .where(eq(whatsappContacts.waId, m.from));
    await sendButtons(m.from, ROUTE_PROMPT, CHOICES);
    return;
  }
  if (!bot || bot.status !== "live") {
    await sendText(m.from, "Sorry, that assistant isn't available right now.");
    return;
  }
  if (!question.trim()) {
    await sendText(m.from, bot.welcome || `Hi, I'm ${bot.name}. What would you like to know?`);
    return;
  }

  const turn = await visitorMessage({
    bot,
    conversation: await openConversation(m.from, bot.id),
    channel: "whatsapp",
    text: question,
    waId: m.from,
    externalId: m.id,
  });
  if (turn.conversationId && m.profileName) {
    await db
      .update(conversations)
      .set({ contact: { name: m.profileName.slice(0, 120), phone: `+${m.from}` } })
      .where(
        and(
          eq(conversations.id, turn.conversationId),
          inArray(conversations.status, ["bot", "waiting", "live"]),
        ),
      );
  }

  // Everything after the person's own message goes back, one WhatsApp message each.
  await deliver(
    m.from,
    turn.messages.slice(1).filter((x) => x.role === "bot" || x.role === "system"),
  );
  if (turn.offer) {
    await sendText(m.from, 'Reply "team" and I\'ll pass your question to a person.');
  }
  if (turn.form) {
    await sendText(
      m.from,
      "Please reply with your name, company and stand number, and the team will get back to you here.",
    );
  }
}
