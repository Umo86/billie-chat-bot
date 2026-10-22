import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { conversations, emailThreads, gaps } from "@/lib/db/schema";
import { can, type Actor } from "@/lib/authz";

/** The yellow counts beside Inbox, Emails and Knowledge. */
export type NavCounts = { inbox: number; emails: number; gaps: number };

export async function navCounts(actor: Actor): Promise<NavCounts> {
  const [inbox, emails, open] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .where(inArray(conversations.status, ["waiting", "ticket"])),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailThreads)
      .where(inArray(emailThreads.status, ["draft_ready", "needs_you", "failed"])),
    can(actor, "knowledge.view")
      ? db
          .select({ n: sql<number>`count(*)::int` })
          .from(gaps)
          .where(inArray(gaps.status, ["open"]))
      : Promise.resolve([{ n: 0 }]),
  ]);
  return { inbox: inbox[0]?.n ?? 0, emails: emails[0]?.n ?? 0, gaps: open[0]?.n ?? 0 };
}
