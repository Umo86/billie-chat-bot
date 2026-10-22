import "server-only";
import { and, isNotNull, lt, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { bots, conversations, emailThreads, knowledgeBases, sources } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { deleteStoredFile } from "@/lib/storage";

/**
 * UK GDPR housekeeping (daily job): chats and emails older than the
 * retention setting are deleted with their messages; anything in the bin
 * for more than 30 days is removed for good, files included. Each run writes
 * one audit row with the counts, never the content.
 */
export const BIN_DAYS = 30;

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

  const oldSources = await db
    .delete(sources)
    .where(and(isNotNull(sources.deletedAt), lt(sources.deletedAt, binCutoff)))
    .returning({ id: sources.id, fileKey: sources.fileKey });
  for (const s of oldSources) await deleteStoredFile(s.fileKey);
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
  for (const f of kbFiles) await deleteStoredFile(f.file_key);
  const oldKbs = await db
    .delete(knowledgeBases)
    .where(and(isNotNull(knowledgeBases.deletedAt), lt(knowledgeBases.deletedAt, binCutoff)))
    .returning({ id: knowledgeBases.id });

  const counts = {
    chats: chats.length,
    emails: emails.length,
    sources: oldSources.length,
    bots: oldBots.length,
    knowledgeBases: oldKbs.length,
  };
  if (Object.values(counts).some((n) => n > 0)) {
    await writeAudit(db, {
      actorType: "system",
      entityType: "retention",
      action: "purge",
      summary: `Retention: deleted ${counts.chats} chats and ${counts.emails} emails older than ${s.retentionMonths} months; emptied ${counts.sources + counts.bots + counts.knowledgeBases} items from the bin`,
      after: counts,
    });
  }
  return counts;
}
