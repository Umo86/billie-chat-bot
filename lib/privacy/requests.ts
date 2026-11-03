import "server-only";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import {
  bots,
  chatRequests,
  conversations,
  emailThreads,
  emailTombstones,
  deadlines,
  exhibitorLists,
  exhibitors,
  messages,
  reminderBatches,
  reminders,
  whatsappContacts,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";

/**
 * UK GDPR requests about one person: find what Billie holds (chats they left
 * details in or signed in to, WhatsApp chats from their number, emails from
 * their address, requests they sent from a chat's form, their rows on
 * exhibitor lists and deadline reminders to them), give them a copy, or
 * delete it. Searches by email address or phone number.
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
  const requests =
    q.kind === "email"
      ? await query<{ id: string }>(
          db,
          sql`SELECT id FROM chat_requests WHERE lower(contact->>'email') = ${q.value}`,
        )
      : await query<{ id: string }>(
          db,
          sql`SELECT id FROM chat_requests
              WHERE regexp_replace(regexp_replace(coalesce(contact->>'phone', ''), '\\D', '', 'g'), '^0', '44') = ${q.value}`,
        );
  // Exhibitor lists hold email addresses (lower case). A row can list several
  // people at one company: only chats signed in with this address are theirs
  // (from before addresses were kept, only a row with no one else on it).
  const listed =
    q.kind === "email"
      ? await query<{ id: string }>(
          db,
          sql`SELECT id FROM exhibitors WHERE emails @> ARRAY[${q.value}]::text[]`,
        )
      : [];
  const exhibitorIds = listed.map((r) => r.id);
  const signedIn =
    q.kind === "email"
      ? await query<{ id: string }>(
          db,
          sql`SELECT id FROM conversations
              WHERE signed_in_email = ${q.value}
                 OR (signed_in_email IS NULL AND exhibitor_id IN
                      (SELECT id FROM exhibitors WHERE emails = ARRAY[${q.value}]::text[]))`,
        )
      : [];
  const reminded =
    q.kind === "email"
      ? await query<{ id: string }>(
          db,
          sql`SELECT id FROM reminders WHERE "to" @> ARRAY[${q.value}]::text[]`,
        )
      : [];
  return {
    chatIds: [...new Set([...chats, ...signedIn].map((r) => r.id))],
    emailIds: emails.map((r) => r.id),
    requestIds: requests.map((r) => r.id),
    exhibitorIds,
    reminderIds: reminded.map((r) => r.id),
  };
}

export async function findPerson(raw: string) {
  const q = parsePersonQuery(raw);
  const { chatIds, emailIds, requestIds, exhibitorIds, reminderIds } = await matchingIds(q);
  return {
    query: q,
    chats: chatIds.length,
    emails: emailIds.length,
    requests: requestIds.length,
    exhibitors: exhibitorIds.length,
    reminders: reminderIds.length,
  };
}

/** Everything Billie holds about the person, for a subject access request. */
export async function exportPerson(actor: Actor, raw: string) {
  const q = parsePersonQuery(raw);
  const { chatIds, emailIds, requestIds, exhibitorIds, reminderIds } = await matchingIds(q);
  const reminded = reminderIds.length
    ? await db
        .select({
          bot: bots.name,
          deadline: deadlines.name,
          dueOn: deadlines.dueOn,
          company: reminders.company,
          stand: reminders.stand,
          name: reminders.name,
          to: reminders.to,
          status: reminders.status,
          sentAt: reminders.sentAt,
        })
        .from(reminders)
        .innerJoin(reminderBatches, eq(reminderBatches.id, reminders.batchId))
        .innerJoin(deadlines, eq(deadlines.id, reminderBatches.deadlineId))
        .innerJoin(bots, eq(bots.id, reminderBatches.botId))
        .where(inArray(reminders.id, reminderIds))
    : [];
  const listed = exhibitorIds.length
    ? await db
        .select({
          bot: bots.name,
          company: exhibitors.company,
          stand: exhibitors.stand,
          name: exhibitors.name,
          emails: exhibitors.emails,
          fields: exhibitors.fields,
        })
        .from(exhibitors)
        .innerJoin(bots, eq(bots.id, exhibitors.botId))
        .where(inArray(exhibitors.id, exhibitorIds))
    : [];
  const requests = requestIds.length
    ? await db
        .select({
          ref: chatRequests.ref,
          request: chatRequests.typeName,
          status: chatRequests.status,
          answers: chatRequests.answers,
          contact: chatRequests.contact,
          note: chatRequests.note,
          sentAt: chatRequests.createdAt,
        })
        .from(chatRequests)
        .where(inArray(chatRequests.id, requestIds))
    : [];
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
          sentText: emailThreads.sentText,
          status: emailThreads.status,
        })
        .from(emailThreads)
        .where(inArray(emailThreads.id, emailIds))
    : [];
  // Someone else's address on the same row or reminder isn't theirs to have.
  const mine = (to: string[]) => (q.kind === "email" ? to.filter((t) => t === q.value) : []);
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: "privacy",
    entityId: null,
    action: "export",
    summary: `Exported a person's data (${chats.length} chats, ${emails.length} emails, ${requests.length} requests, ${listed.length} exhibitor list rows, ${reminded.length} reminders)`,
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
    requests: requests.map((r) => ({ ...r, ref: `R-${r.ref}` })),
    exhibitorLists: listed.map((l) => ({ ...l, emails: mine(l.emails) })),
    reminders: reminded.map((r) => ({ ...r, to: mine(r.to) })),
  };
}

/**
 * Deletes the person's chats (with their messages), emails and requests.
 * Their address comes off exhibitor list rows and reminders, and a row or
 * reminder with nobody else on it goes. The audit row keeps counts only.
 */
export async function deletePerson(actor: Actor, raw: string) {
  const q = parsePersonQuery(raw);
  const { chatIds, emailIds, requestIds, exhibitorIds, reminderIds } = await matchingIds(q);
  await db.transaction(async (tx) => {
    if (reminderIds.length && q.kind === "email") {
      await tx
        .update(reminders)
        .set({ to: sql`array_remove(${reminders.to}, ${q.value})` })
        .where(inArray(reminders.id, reminderIds));
      await tx
        .delete(reminders)
        .where(and(inArray(reminders.id, reminderIds), sql`cardinality(${reminders.to}) = 0`));
    }
    if (exhibitorIds.length && q.kind === "email") {
      // Others at the same company keep their row (and can still sign in).
      await tx
        .update(exhibitors)
        .set({ emails: sql`array_remove(${exhibitors.emails}, ${q.value})` })
        .where(inArray(exhibitors.id, exhibitorIds));
      const gone = await tx
        .delete(exhibitors)
        .where(
          and(inArray(exhibitors.id, exhibitorIds), sql`cardinality(${exhibitors.emails}) = 0`),
        )
        .returning({ botId: exhibitors.botId });
      // Keep each list's count right.
      for (const botId of new Set(gone.map((g) => g.botId)))
        await tx
          .update(exhibitorLists)
          .set({
            rows: sql`(SELECT count(*)::int FROM ${exhibitors} WHERE ${exhibitors.botId} = ${botId})`,
          })
          .where(eq(exhibitorLists.botId, botId));
    }
    if (requestIds.length)
      await tx.delete(chatRequests).where(inArray(chatRequests.id, requestIds));
    if (chatIds.length) await tx.delete(conversations).where(inArray(conversations.id, chatIds));
    if (emailIds.length) {
      // Outlook keeps its copy: remember not to take those emails in again.
      const outlook = await tx
        .select({ externalId: emailThreads.externalId })
        .from(emailThreads)
        .where(and(inArray(emailThreads.id, emailIds), isNotNull(emailThreads.externalId)));
      if (outlook.length)
        await tx
          .insert(emailTombstones)
          .values(outlook.map((e) => ({ externalId: e.externalId! })))
          .onConflictDoNothing();
      await tx.delete(emailThreads).where(inArray(emailThreads.id, emailIds));
    }
    if (q.kind === "phone")
      await tx.delete(whatsappContacts).where(sql`${whatsappContacts.waId} = ${q.value}`);
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "privacy",
      entityId: null,
      action: "delete",
      summary: `Deleted a person's data on request (${chatIds.length} chats, ${emailIds.length} emails, ${requestIds.length} requests, ${exhibitorIds.length} exhibitor list rows, ${reminderIds.length} reminders)`,
    });
  });
  return {
    chats: chatIds.length,
    emails: emailIds.length,
    requests: requestIds.length,
    exhibitors: exhibitorIds.length,
    reminders: reminderIds.length,
  };
}
