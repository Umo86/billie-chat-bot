import "server-only";
import { and, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import {
  bots,
  chatRequests,
  conversations,
  emailSuggestions,
  emailThreads,
  emailTombstones,
  exhibitorCodes,
  exhibitorLists,
  exhibitors,
  knowledgeBases,
  reminderBatches,
  sources,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { deleteStoredFile } from "@/lib/storage";
import { pruneReused } from "@/lib/ai/reuse";

/**
 * UK GDPR housekeeping (daily job): chats and emails older than the
 * retention setting are deleted with their messages, and so are exhibitor
 * lists nobody has uploaded again in that time and answers found in past
 * emails; anything in the bin for more
 * than 30 days is removed for good, files included. Each run writes one
 * audit row with the counts, never the content.
 */
export const BIN_DAYS = 30;
/** How long erased Outlook emails are remembered (longer than the sync's one-week window). */
export const TOMBSTONE_DAYS = 30;

export function retentionCutoff(months: number, now = new Date()): Date {
  const d = new Date(now);
  d.setMonth(d.getMonth() - Math.max(1, months));
  return d;
}

export async function runRetention(now = new Date()): Promise<Record<string, number>> {
  const s = await getSettings();
  const cutoff = retentionCutoff(s.retentionMonths, now);
  const binCutoff = new Date(now.getTime() - BIN_DAYS * 86_400_000);

  const chats = await db
    .delete(conversations)
    .where(lt(conversations.lastMessageAt, cutoff))
    .returning({ id: conversations.id });
  const emails = await db
    .delete(emailThreads)
    .where(lt(emailThreads.receivedAt, cutoff))
    .returning({ id: emailThreads.id });
  const requests = await db
    .delete(chatRequests)
    .where(lt(chatRequests.updatedAt, cutoff))
    .returning({ id: chatRequests.id });
  // A list for a show that's long over: its exhibitors go with it.
  const oldLists = await db.transaction(async (tx) => {
    const gone = await tx
      .delete(exhibitorLists)
      .where(lt(exhibitorLists.uploadedAt, cutoff))
      .returning({ botId: exhibitorLists.botId });
    if (gone.length)
      await tx.delete(exhibitors).where(
        inArray(
          exhibitors.botId,
          gone.map((l) => l.botId),
        ),
      );
    return gone;
  });
  // Deadline reminders (who they went to, and what) go with their round.
  const oldReminders = await db
    .delete(reminderBatches)
    .where(lt(reminderBatches.createdAt, cutoff))
    .returning({ id: reminderBatches.id });
  // Answers found in past emails: written from the emails, so they go when emails would.
  const oldSuggestions = await db
    .delete(emailSuggestions)
    .where(lt(emailSuggestions.createdAt, cutoff))
    .returning({ id: emailSuggestions.id });
  // Answers kept to give again are only for their day.
  await pruneReused(now);
  // Sign-in codes last ten minutes; keep a day, for the attempts count.
  await db
    .delete(exhibitorCodes)
    .where(lt(exhibitorCodes.createdAt, new Date(now.getTime() - 86_400_000)));
  // Erased Outlook emails only need remembering while the sync could still take them (a week).
  await db
    .delete(emailTombstones)
    .where(lt(emailTombstones.createdAt, new Date(now.getTime() - TOMBSTONE_DAYS * 86_400_000)));

  const oldSources = await db
    .delete(sources)
    .where(and(isNotNull(sources.deletedAt), lt(sources.deletedAt, binCutoff)))
    .returning({ id: sources.id, fileKey: sources.fileKey });
  // A bot takes its own knowledge with it: note the files of its sources first.
  const botFiles = await query<{ file_key: string | null }>(
    db,
    sql`SELECT s.file_key FROM sources s
          JOIN knowledge_bases kb ON kb.id = s.knowledge_base_id
          JOIN bots b ON b.id = kb.bot_id
        WHERE b.deleted_at IS NOT NULL AND b.deleted_at < ${binCutoff.toISOString()} AND s.file_key IS NOT NULL`,
  );
  const oldBots = await db
    .delete(bots)
    .where(and(isNotNull(bots.deletedAt), lt(bots.deletedAt, binCutoff)))
    .returning({ id: bots.id });
  // Files of sources inside knowledge bases about to go.
  const kbFiles = await query<{ file_key: string | null }>(
    db,
    sql`SELECT s.file_key FROM sources s JOIN knowledge_bases kb ON kb.id = s.knowledge_base_id
        WHERE kb.deleted_at IS NOT NULL AND kb.deleted_at < ${binCutoff.toISOString()} AND s.file_key IS NOT NULL`,
  );
  const oldKbs = await db
    .delete(knowledgeBases)
    .where(and(isNotNull(knowledgeBases.deletedAt), lt(knowledgeBases.deletedAt, binCutoff)))
    .returning({ id: knowledgeBases.id });
  await deleteUnusedFiles([
    ...oldSources.map((s) => s.fileKey),
    ...botFiles.map((f) => f.file_key),
    ...kbFiles.map((f) => f.file_key),
  ]);

  const counts = {
    chats: chats.length,
    emails: emails.length,
    requests: requests.length,
    exhibitorLists: oldLists.length,
    reminderRounds: oldReminders.length,
    emailSuggestions: oldSuggestions.length,
    sources: oldSources.length,
    bots: oldBots.length,
    knowledgeBases: oldKbs.length,
  };
  if (Object.values(counts).some((n) => n > 0)) {
    await writeAudit(db, {
      actorType: "system",
      entityType: "retention",
      action: "purge",
      summary: `Retention: deleted ${counts.chats} chats, ${counts.emails} emails, ${counts.requests} requests, ${counts.exhibitorLists} exhibitor lists and ${counts.reminderRounds} rounds of reminders older than ${s.retentionMonths} months; emptied ${counts.sources + counts.bots + counts.knowledgeBases} items from the bin`,
      after: counts,
    });
  }
  return counts;
}

/** Deletes stored files that no remaining source uses (a copied source can share one). */
async function deleteUnusedFiles(keys: (string | null)[]): Promise<void> {
  const gone = [...new Set(keys.filter((k): k is string => Boolean(k)))];
  if (!gone.length) return;
  const used = new Set(
    (
      await db.select({ key: sources.fileKey }).from(sources).where(inArray(sources.fileKey, gone))
    ).map((r) => r.key),
  );
  for (const key of gone) if (!used.has(key)) await deleteStoredFile(key);
}
