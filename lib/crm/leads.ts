import "server-only";
import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/lib/db/client";
import { bots, chatRequests, conversations } from "@/lib/db/schema";
import type { CrmIds } from "@/lib/db/schema/requests";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { appUrl } from "@/lib/config";
import { requestRef } from "@/lib/requests/rules";
import type { Actor } from "@/lib/authz";
import type { ContactDetails, RequestAnswer } from "@/lib/types";
import { twentyConfigured, type Lead } from "./lead-rules";
import { pushLead, TwentyError } from "./twenty";

/**
 * Leads to the CRM: a request whose type says "send to Twenty" (Rules step,
 * the ready-made "Interested in exhibiting" form on visitor bots) is queued
 * here when it's made, and the crm_lead job sends it. Until Twenty is
 * connected it waits, and the team can send it from the request's page.
 */

/** In the transaction that makes the request. */
export async function queueLead(tx: DbOrTx, requestId: string): Promise<void> {
  const connected = twentyConfigured();
  await tx
    .update(chatRequests)
    .set({ crmStatus: connected ? "queued" : "waiting", crmNote: "" })
    .where(eq(chatRequests.id, requestId));
  if (connected)
    await enqueue(
      "crm_lead",
      { requestId },
      { tx, dedupeKey: `crm-lead:${requestId}`, maxAttempts: 6 },
    );
}

/** The team presses "Send to Twenty" (a lead that waited, or failed). */
export async function resendLead(actor: Actor, requestId: string): Promise<void> {
  if (!twentyConfigured())
    throw new UserError("Twenty isn't connected yet. Add its API key first (Settings).");
  await db.transaction(async (tx) => {
    const [r] = await tx
      .update(chatRequests)
      .set({ crmStatus: "queued", crmNote: "" })
      .where(eq(chatRequests.id, requestId))
      .returning({ id: chatRequests.id, ref: chatRequests.ref, status: chatRequests.crmStatus });
    if (!r) throw new UserError("That request no longer exists.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "request",
      entityId: r.id,
      action: "update",
      summary: `Sent ${requestRef(r.ref)} to Twenty`,
    });
    await enqueue(
      "crm_lead",
      { requestId },
      { tx, dedupeKey: `crm-lead:${requestId}`, maxAttempts: 6 },
    );
  });
  await kickJobs();
}

/** The crm_lead job. Throws to be tried again later; a lasting problem is noted on the request. */
export async function sendLead(requestId: string, opts: { lastTry?: boolean } = {}): Promise<void> {
  const [row] = await db
    .select({
      r: chatRequests,
      botName: bots.name,
      show: bots.showName,
      page: conversations.pageUrl,
    })
    .from(chatRequests)
    .innerJoin(bots, eq(bots.id, chatRequests.botId))
    .leftJoin(conversations, eq(conversations.id, chatRequests.conversationId))
    .where(eq(chatRequests.id, requestId));
  if (!row || row.r.crmStatus === "sent") return;
  const r = row.r;
  const lead: Lead = {
    contact: r.contact as ContactDetails,
    answers: r.answers as RequestAnswer[],
    show: row.show,
    botName: row.botName,
    ref: requestRef(r.ref),
    page: row.page,
    chatUrl: r.conversationId
      ? `${appUrl()}/inbox?tab=billie&c=${r.conversationId}`
      : `${appUrl()}/requests?r=${r.id}`,
  };
  const fail = (note: string) =>
    db
      .update(chatRequests)
      .set({ crmStatus: "failed", crmNote: note })
      .where(eq(chatRequests.id, requestId));
  let ids: CrmIds;
  try {
    ids = await pushLead(lead, (r.crmIds as Partial<CrmIds> | null) ?? {});
  } catch (err) {
    if (err instanceof TwentyError) {
      if (err.retry && !opts.lastTry) throw err;
      await fail(err.message);
      return;
    }
    if (!opts.lastTry) throw err;
    await fail("Sending to Twenty didn't work. Try again from this page.");
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(chatRequests)
      .set({ crmStatus: "sent", crmNote: "", crmIds: ids, crmSentAt: new Date() })
      .where(eq(chatRequests.id, requestId));
    await writeAudit(tx, {
      actorType: "system",
      entityType: "request",
      entityId: requestId,
      action: "update",
      summary: `Sent ${lead.ref} to Twenty as a lead`,
    });
  });
}
