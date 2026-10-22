import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, conversations, messages, whatsappContacts } from "@/lib/db/schema";
import { emailConfigured, whatsappConfigured } from "@/lib/config";
import { PermanentJobError } from "@/lib/jobs/queue";
import { sendText, withinReplyWindow } from "@/lib/channels/whatsapp";
import { sendEmail } from "@/lib/email/send";
import type { AnswerMeta, ContactDetails } from "@/lib/types";

/**
 * Sending a staff reply back the way the question came (the
 * "send_staff_reply" job): WhatsApp within its 24-hour window, or email to
 * someone who left their details. When it can't go (no connection, window
 * closed), the message records why, and the Inbox shows it.
 */
async function note(messageId: string, meta: AnswerMeta, error: string) {
  await db
    .update(messages)
    .set({ meta: { ...meta, error } })
    .where(eq(messages.id, messageId));
}

export async function deliverStaffReply(
  messageId: string,
  via: "whatsapp" | "email",
): Promise<void> {
  const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!msg) throw new PermanentJobError("Message not found");
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, msg.conversationId),
  });
  if (!conv) throw new PermanentJobError("Chat not found");
  const meta = msg.meta as AnswerMeta;

  if (via === "whatsapp") {
    if (!whatsappConfigured() || !conv.waId)
      return note(messageId, meta, "Not sent: WhatsApp isn't connected.");
    const contact = await db.query.whatsappContacts.findFirst({
      where: eq(whatsappContacts.waId, conv.waId),
    });
    if (!withinReplyWindow(contact?.lastInboundAt ?? conv.lastVisitorAt)) {
      return note(
        messageId,
        meta,
        "Not sent: it's over 24 hours since they wrote, so WhatsApp only allows an approved template.",
      );
    }
    await sendText(conv.waId, msg.text);
    return;
  }

  const contact = conv.contact as ContactDetails;
  if (!contact.email) return note(messageId, meta, "Not sent: they didn't leave an email address.");
  if (!emailConfigured())
    return note(
      messageId,
      meta,
      "Not sent: email isn't set up. Copy the reply and send it from Outlook.",
    );
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, conv.botId) });
  const firstQuestion = await db.query.messages.findFirst({
    where: and(eq(messages.conversationId, conv.id), eq(messages.role, "visitor")),
    orderBy: asc(messages.createdAt),
  });
  const name = (contact.name ?? "").split(/\s+/)[0];
  await sendEmail({
    to: contact.email,
    subject: `Your question to ${bot?.name ?? "the team"}${bot?.showName ? ` (${bot.showName})` : ""}`,
    text: [
      name ? `Hi ${name},` : "Hello,",
      "",
      msg.text,
      "",
      firstQuestion ? `You asked: "${firstQuestion.text.slice(0, 500)}"` : "",
    ].join("\n"),
  });
}
