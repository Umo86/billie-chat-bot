import "server-only";
import { asc, inArray, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { conversations, emailThreads, messages, whatsappContacts } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";

/**
 * UK GDPR requests about one person: find what Billie holds (chats they left
 * details in, WhatsApp chats from their number, emails from their address),
 * give them a copy, or delete it. Searches by email address or phone number.
 */
export type PersonQuery = { kind: "email"; value: string } | { kind: "phone"; value: string };

export function parsePersonQuery(raw: string): PersonQuery {
  const s = raw.trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return { kind: "email", value: s };
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 7 && digits.length <= 15 && /^[+()\d\s-]+$/.test(s))
    return { kind: "phone", value: digits.replace(/^0/, "44") };
  throw new UserError("Enter an email address or a phone number.");
}

async function matchingIds(q: PersonQuery) {
  const chats =
    q.kind === "email"
      ? await query<{ id: string }>(
          db,
          sql`SELECT id FROM conversations WHERE lower(contact->>'email') = ${q.value}`,
        )
      : await query<{ id: string }>(
          db,
          sql`SELECT id FROM conversations
              WHERE wa_id = ${q.value}
                 OR regexp_replace(regexp_replace(coalesce(contact->>'phone', ''), '\\D', '', 'g'), '^0', '44') = ${q.value}`,
        );
  const emails =
    q.kind === "email"
      ? await query<{ id: string }>(
          db,
          sql`SELECT id FROM email_threads WHERE lower(from_email) = ${q.value}`,
        )
      : [];
  return { chatIds: chats.map((r) => r.id), emailIds: emails.map((r) => r.id) };
}

export async function findPerson(raw: string) {
  const q = parsePersonQuery(raw);
  const { chatIds, emailIds } = await matchingIds(q);
  return { query: q, chats: chatIds.length, emails: emailIds.length };
}

/** Everything Billie holds about the person, for a subject access request. */
export async function exportPerson(actor: Actor, raw: string) {
  const q = parsePersonQuery(raw);
  const { chatIds, emailIds } = await matchingIds(q);
  const chats = chatIds.length
    ? await db.select().from(conversations).where(inArray(conversations.id, chatIds))
    : [];
  const lines = chatIds.length
    ? await db
        .select({
          conversationId: messages.conversationId,
          role: messages.role,
          text: messages.text,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(inArray(messages.conversationId, chatIds))
        .orderBy(asc(messages.createdAt))
    : [];
  const emails = emailIds.length
    ? await db
        .select({
          receivedAt: emailThreads.receivedAt,
          fromName: emailThreads.fromName,
          fromEmail: emailThreads.fromEmail,
          subject: emailThreads.subject,
          body: emailThreads.body,
          draft: emailThreads.draft,
          status: emailThreads.status,
        })
        .from(emailThreads)
        .where(inArray(emailThreads.id, emailIds))
    : [];
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: "privacy",
    entityId: null,
    action: "export",
    summary: `Exported a person's data (${chats.length} chats, ${emails.length} emails)`,
  });
  return {
    generatedAt: new Date().toISOString(),
    searchedFor: q,
    chats: chats.map((c) => ({
      startedAt: c.createdAt,
      channel: c.channel,
      contact: c.contact,
      pageUrl: c.pageUrl,
      messages: lines
        .filter((l) => l.conversationId === c.id)
        .map((l) => ({ at: l.createdAt, from: l.role, text: l.text })),
    })),
    emails,
  };
}

/** Deletes the person's chats (with their messages) and emails. The audit row keeps counts only. */
export async function deletePerson(actor: Actor, raw: string) {
  const q = parsePersonQuery(raw);
  const { chatIds, emailIds } = await matchingIds(q);
  await db.transaction(async (tx) => {
    if (chatIds.length) await tx.delete(conversations).where(inArray(conversations.id, chatIds));
    if (emailIds.length) await tx.delete(emailThreads).where(inArray(emailThreads.id, emailIds));
    if (q.kind === "phone")
      await tx.delete(whatsappContacts).where(sql`${whatsappContacts.waId} = ${q.value}`);
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "privacy",
      entityId: null,
      action: "delete",
      summary: `Deleted a person's data on request (${chatIds.length} chats, ${emailIds.length} emails)`,
    });
  });
  return { chats: chatIds.length, emails: emailIds.length };
}
