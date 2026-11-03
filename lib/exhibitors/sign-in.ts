import "server-only";
import { randomInt } from "node:crypto";
import { and, desc, eq, gt, notExists, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { conversations, exhibitorCodes, exhibitors, messages } from "@/lib/db/schema";
import { insertMessage } from "@/lib/conversations/service";
import { writeAudit } from "@/lib/audit";
import { sendEmail, type OutgoingEmail } from "@/lib/email/send";
import { hashToken, tokensMatch } from "@/lib/chat/token";
import type { BotRow } from "@/lib/bots/load";
import type { ContactDetails } from "@/lib/types";
import { exhibitorByEmail, signInOpen, type SignedIn } from "./service";

/**
 * Exhibitors signing in from the chat, so Billie can answer about their own
 * stand: they type the email they booked with, get a six-digit code by
 * email (only if that email is on the bot's exhibitor list, though the chat
 * never says which), and type it in. Codes last ten minutes and five tries,
 * and are kept only as a hash. Web chat and the chat page only.
 */

export const CODE_MINUTES = 10;
export const CODE_TRIES = 5;

export class SignInError extends Error {}

export { signInOpen };

const SENT =
  "If that email is on the exhibitor list, we've sent it a six-digit code. It can take a minute to arrive.";

/**
 * Sends the code once the chat has had its answer, so neither how long it
 * waited nor a failed send says whether the email is on the list. Outside a
 * request (tests, scripts) it sends straight away.
 */
async function sendSoon(email: OutgoingEmail): Promise<void> {
  const go = () =>
    sendEmail(email).catch((err) =>
      console.warn("sign-in code not sent", err instanceof Error ? err.message : err),
    );
  try {
    const { after } = await import("next/server");
    after(go);
  } catch {
    await go();
  }
}

function codeHash(conversationId: string, code: string): string {
  return hashToken(`${conversationId}:${code}`);
}

/** Sends a code to the email if it's on the list. Always answers the same, either way. */
export async function requestCode(
  bot: BotRow,
  conversationId: string,
  email: string,
): Promise<string> {
  if (!(await signInOpen(bot))) throw new SignInError("Signing in isn't available in this chat.");
  const exhibitor = await exhibitorByEmail(bot.id, email);
  if (!exhibitor) return SENT;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(exhibitorCodes).values({
    conversationId,
    exhibitorId: exhibitor.id,
    codeHash: codeHash(conversationId, code),
    expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
  });
  await sendSoon({
    to: email.trim().toLowerCase(),
    subject: `Your code for ${bot.showName || bot.name}: ${code}`,
    text: [
      `Your code to sign in to the ${bot.showName || bot.name} chat is ${code}.`,
      "",
      `It works for ${CODE_MINUTES} minutes. If you didn't ask for it, ignore this email: nobody can sign in without the code.`,
    ].join("\n"),
  });
  return SENT;
}

export type { SignedIn } from "./service";

/** Checks the code; signs the chat in as that exhibitor. */
export async function verifyCode(
  bot: BotRow,
  conversationId: string,
  code: string,
): Promise<SignedIn> {
  const clean = code.replace(/\D/g, "");
  // A wrong try must be counted, so the transaction commits and the error comes after.
  const outcome = await db.transaction(async (tx): Promise<{ error: string } | SignedIn> => {
    const [c] = await tx
      .select()
      .from(exhibitorCodes)
      .where(
        and(
          eq(exhibitorCodes.conversationId, conversationId),
          eq(exhibitorCodes.used, false),
          gt(exhibitorCodes.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(exhibitorCodes.createdAt))
      .limit(1)
      .for("update");
    if (!c) return { error: "That code has run out. Ask for a new one." };
    if (c.attempts >= CODE_TRIES)
      return { error: "Too many tries with that code. Ask for a new one." };
    if (clean.length !== 6 || !tokensMatch(`${conversationId}:${clean}`, c.codeHash)) {
      await tx
        .update(exhibitorCodes)
        .set({ attempts: c.attempts + 1 })
        .where(eq(exhibitorCodes.id, c.id));
      return { error: "That code isn't right. Check the email and try again." };
    }
    await tx.update(exhibitorCodes).set({ used: true }).where(eq(exhibitorCodes.id, c.id));
    const ex = await tx.query.exhibitors.findFirst({ where: eq(exhibitors.id, c.exhibitorId) });
    if (!ex || ex.botId !== bot.id) return { error: "That code has run out. Ask for a new one." };
    const conv = await tx.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });
    const contact = { ...((conv?.contact as ContactDetails) ?? {}) };
    contact.name ||= ex.name || undefined;
    contact.company ||= ex.company || undefined;
    contact.stand ||= ex.stand || undefined;
    contact.email ||= ex.emails[0];
    await tx
      .update(conversations)
      .set({ exhibitorId: ex.id, contact })
      .where(eq(conversations.id, conversationId));
    const who = [ex.name, ex.company].filter(Boolean).join(", ") || ex.emails[0];
    await insertMessage(tx, conversationId, {
      role: "system",
      text: `Signed in as ${who}${ex.stand ? ` (stand ${ex.stand})` : ""}. Ask about your own stand now.`,
    });
    await writeAudit(tx, {
      actorType: "visitor",
      entityType: "conversation",
      entityId: conversationId,
      action: "login",
      summary: `An exhibitor signed in to a chat with ${bot.name}`,
    });
    return { name: ex.name, company: ex.company, stand: ex.stand };
  });
  if ("error" in outcome) throw new SignInError(outcome.error);
  return outcome;
}

/** Removes a chat that signing in started, if nothing happened in it. */
export async function dropEmptyConversation(conversationId: string): Promise<void> {
  await db.delete(conversations).where(
    and(
      eq(conversations.id, conversationId),
      notExists(
        db
          .select({ one: sql`1` })
          .from(messages)
          .where(eq(messages.conversationId, conversationId)),
      ),
    ),
  );
}

export async function signOut(conversationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({ exhibitorId: null })
      .where(eq(conversations.id, conversationId));
    await insertMessage(tx, conversationId, {
      role: "system",
      text: "Signed out. Billie won't use your stand's details in this chat any more.",
    });
  });
}
