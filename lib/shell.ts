import "server-only";
import { and, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { chatRequests, conversations, emailThreads, gaps } from "@/lib/db/schema";
import { can, type Actor } from "@/lib/authz";
import { inBots, myBotIds } from "@/lib/auth/bots";

/** The yellow counts beside Inbox, Requests, Emails and Knowledge: the actor's bots only. */
export type NavCounts = { inbox: number; requests: number; emails: number; gaps: number };

export async function navCounts(actor: Actor): Promise<NavCounts> {
  const ids = await myBotIds(actor);
  const [inbox, requests, emails, open] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .where(
        and(inArray(conversations.status, ["waiting", "ticket"]), inBots(ids, conversations.botId)),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(chatRequests)
      .where(and(inArray(chatRequests.status, ["new"]), inBots(ids, chatRequests.botId))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailThreads)
      .where(
        and(
          inArray(emailThreads.status, ["draft_ready", "needs_you", "failed"]),
          inBots(ids, emailThreads.botId),
        ),
      ),
    can(actor, "knowledge.view")
      ? db
          .select({ n: sql<number>`count(*)::int` })
          .from(gaps)
          .where(and(inArray(gaps.status, ["open"]), inBots(ids, gaps.botId)))
      : Promise.resolve([{ n: 0 }]),
  ]);
  return {
    inbox: inbox[0]?.n ?? 0,
    requests: requests[0]?.n ?? 0,
    emails: emails[0]?.n ?? 0,
    gaps: open[0]?.n ?? 0,
  };
}
