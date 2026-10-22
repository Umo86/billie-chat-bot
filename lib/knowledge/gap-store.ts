import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { questionKey } from "./gaps";

/**
 * Recording a question a bot couldn't answer. The same question asked again
 * adds to its count; one that was answered but still stumps the bot opens
 * again; a dismissed one stays dismissed.
 */
export async function recordGap(botId: string, question: string, now = new Date()): Promise<void> {
  const key = questionKey(question);
  if (!key) return;
  try {
    await db.execute(sql`
      INSERT INTO gaps (bot_id, question_key, question, ask_count, status, first_asked_at, last_asked_at, updated_at)
      VALUES (${botId}, ${key}, ${question.trim().slice(0, 400)}, 1, 'open', ${now.toISOString()}, ${now.toISOString()}, ${now.toISOString()})
      ON CONFLICT (bot_id, question_key) DO UPDATE SET
        ask_count = gaps.ask_count + 1,
        last_asked_at = EXCLUDED.last_asked_at,
        updated_at = EXCLUDED.updated_at,
        status = CASE WHEN gaps.status = 'dismissed' THEN gaps.status ELSE 'open' END`);
  } catch (err) {
    // A gap is a nice-to-have: never fail a chat over it.
    console.error("gap not recorded", err instanceof Error ? err.message : err);
  }
}
