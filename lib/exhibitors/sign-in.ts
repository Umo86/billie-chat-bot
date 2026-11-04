import "server-only";
import { randomInt } from "node:crypto";
import { and, desc, eq, gt, notExists, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { conversations, exhibitorCodes, exhibitors, messages } from "@/lib/db/schema";
import { insertMessage } from "@/lib/conversations/service";
import { writeAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/send";
import { hashToken, tokensMatch } from "@/lib/chat/token";
import type { BotRow } from "@/lib/bots/load";
import type { ContactDetails } from "@/lib/types";
import { allow, LIMITS } from "@/lib/rate-limit";
import { exhibitorByEmail, signInOpen, type SignedIn } from "./service";

/**
 * Exhibitors signing in from the chat, so Billie can answer about their own
 * stand: they type the email they booked with, get a six-digit code by
 * email (only if that email is on the bot's exhibitor list, though nothing
 * says which: not the reply, not how long it takes, not what typing a code
 * says), and type it in. Codes last ten minutes and five tries, and are kept
 * only as a hash. Each address gets a few codes an hour and a day, listed or
 * not. Web chat and the chat page only.
 */

export const CODE_MINUTES = 10;
export const CODE_TRIES = 5;

export class SignInError extends Error {}
/** Too many codes for one address: the route answers 429. */
export class SignInLimit extends SignInError {}

export { signInOpen };

const SENT =
  "If that email is on the exhibitor list, we've sent it a six-digit code. It can take a minute to arrive.";
/** Every way a code can fail says the same, so a wrong code can't tell who is listed. */
export const CODE_DIDNT_WORK =
  "That code didn't work. Check the latest email, or ask for a new code.";

/**
 * Work that happens once the chat has had its answer, so how long it waited
 * never says whether the email is on the list. Outside a request (tests,
 * scripts) it runs straight away.
 */
async function soon(work: () => Promise<void>): Promise<void> {
  const go = () =>
    work().catch((err) =>
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

const emailHash = (address: string) => hashToken(`exhibitor-email:${address}`);

/** Sends a code to the email if it's on the list. Always answers the same, either way. */
export async function requestCode(
  bot: BotRow,
  conversationId: string,
  email: string,
): Promise<string> {
  if (!(await signInOpen(bot))) throw new SignInError("Signing in isn't available in this chat.");
  const address = email.trim().toLowerCase();
  if (
    !(await allow(`chat:sign-in:email:${address}`, LIMITS.chatSignInEmail)) ||
    !(await allow(`chat:sign-in:email-day:${address}`, LIMITS.chatSignInEmailDaily))
  )
    throw new SignInLimit(
      "That email has had a lot of codes recently. Use the latest one, or try again later.",
    );
  await soon(async () => {
    const exhibitor = await exhibitorByEmail(bot.id, address);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    // A code row either way (one nobody is sent, if not listed), so typing a code acts the same.
    await db.insert(exhibitorCodes).values({
      conversationId,
      exhibitorId: exhibitor?.id ?? null,
      emailHash: emailHash(address),
      codeHash: codeHash(conversationId, code),
      expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
    });
    if (!exhibitor) return;
    await sendEmail({
      to: address,
      subject: `Your code for ${bot.showName || bot.name}: ${code}`,
      text: [
        `Your code to sign in to the ${bot.showName || bot.name} chat is ${code}.`,
        "",
        `It works for ${CODE_MINUTES} minutes. If you didn't ask for it, ignore this email: nobody can sign in without the code.`,
      ].join("\n"),
    });
  });
  return SENT;
}

export type { SignedIn } from "./service";

/** Checks the code; signs the chat in as that exhibitor. */
export async function verifyCode(
  bot: BotRow,
  conversationId: string,
  code: string,
  now = new Date(),
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
          gt(exhibitorCodes.expiresAt, now),
        ),
      )
      .orderBy(desc(exhibitorCodes.createdAt))
      .limit(1)
      .for("update");
    if (!c || c.attempts >= CODE_TRIES) return { error: CODE_DIDNT_WORK };
    if (clean.length !== 6 || !tokensMatch(`${conversationId}:${clean}`, c.codeHash)) {
      await tx
        .update(exhibitorCodes)
        .set({ attempts: c.attempts + 1 })
        .where(eq(exhibitorCodes.id, c.id));
      return { error: CODE_DIDNT_WORK };
    }
    await tx.update(exhibitorCodes).set({ used: true }).where(eq(exhibitorCodes.id, c.id));
    const ex = c.exhibitorId
      ? await tx.query.exhibitors.findFirst({ where: eq(exhibitors.id, c.exhibitorId) })
      : null;
    // The address the code went to: a row can list several people.
    const address = ex?.emails.find((e) => c.emailHash && emailHash(e) === c.emailHash);
    if (!ex || ex.botId !== bot.id || !address) return { error: CODE_DIDNT_WORK };
    return signInChat(tx, bot, conversationId, ex, address, now, "code");
  });
  if ("error" in outcome) throw new SignInError(outcome.error);
  return outcome;
}

type ListedRow = { id: string; name: string; company: string; stand: string };

/**
 * Signs a chat in as this exhibitor (one address on their row): with a code
 * from their email, or from BluePrint, the exhibitor manual (blueprint.ts).
 */
export async function signInChat(
  tx: Tx,
  bot: Pick<BotRow, "name">,
  conversationId: string,
  ex: ListedRow,
  address: string,
  now: Date,
  via: "code" | "manual",
): Promise<SignedIn> {
  const conv = await tx.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  const contact = { ...((conv?.contact as ContactDetails) ?? {}) };
  contact.name ||= ex.name || undefined;
  contact.company ||= ex.company || undefined;
  contact.stand ||= ex.stand || undefined;
  contact.email ||= address;
  await tx
    .update(conversations)
    .set({ exhibitorId: ex.id, signedInEmail: address, signedInAt: now, contact })
    .where(eq(conversations.id, conversationId));
  const who = [ex.name, ex.company].filter(Boolean).join(", ") || address;
  await insertMessage(tx, conversationId, {
    role: "system",
    text: `Signed in${via === "manual" ? " from the exhibitor manual" : ""} as ${who}${ex.stand ? ` (stand ${ex.stand})` : ""}. Ask about your own stand now.`,
  });
  await writeAudit(tx, {
    actorType: "visitor",
    entityType: "conversation",
    entityId: conversationId,
    action: "login",
    summary: `An exhibitor signed in to a chat with ${bot.name}${via === "manual" ? " from BluePrint" : ""}`,
  });
  return { name: ex.name, company: ex.company, stand: ex.stand };
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
      .set({ exhibitorId: null, signedInEmail: null, signedInAt: null })
      .where(eq(conversations.id, conversationId));
    await insertMessage(tx, conversationId, {
      role: "system",
      text: "Signed out. Billie won't use your stand's details in this chat any more.",
    });
  });
}
