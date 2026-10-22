import "server-only";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { emailThreads } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { enqueue } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";

/**
 * The Emails screen: pasted emails (and, when the mailbox is connected,
 * Outlook's), each with a draft reply from the knowledge base. A person
 * checks every draft; Billie never sends an email by itself.
 */
export type EmailTab = "check" | "done";

const TAB: Record<
  EmailTab,
  ("new" | "working" | "draft_ready" | "needs_you" | "failed" | "sent" | "dismissed")[]
> = {
  check: ["needs_you", "draft_ready", "failed", "new", "working"],
  done: ["sent", "dismissed"],
};

export async function emailList(tab: EmailTab) {
  return db
    .select({
      id: emailThreads.id,
      source: emailThreads.source,
      fromName: emailThreads.fromName,
      fromEmail: emailThreads.fromEmail,
      subject: emailThreads.subject,
      summary: emailThreads.summary,
      status: emailThreads.status,
      tags: emailThreads.tags,
      receivedAt: emailThreads.receivedAt,
    })
    .from(emailThreads)
    .where(inArray(emailThreads.status, TAB[tab]))
    .orderBy(desc(emailThreads.receivedAt))
    .limit(200);
}

export async function emailDetail(id: string) {
  return (await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, id) })) ?? null;
}

export async function addPastedEmail(
  actor: Actor,
  input: {
    fromName: string;
    fromEmail: string;
    subject: string;
    body: string;
    botId: string | null;
  },
): Promise<string> {
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(emailThreads)
      .values({
        source: "manual",
        fromName: input.fromName.trim().slice(0, 120),
        fromEmail: input.fromEmail.trim().toLowerCase().slice(0, 200),
        subject: input.subject.trim().slice(0, 300),
        body: input.body.trim().slice(0, 50_000),
        botId: input.botId,
      })
      .returning({ id: emailThreads.id });
    await enqueue("process_email", { emailId: row.id }, { tx, dedupeKey: `email:${row.id}` });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "email",
      entityId: row.id,
      action: "create",
      summary: "Pasted an email for a draft reply",
    });
    return row.id;
  });
  await kickJobs();
  return id;
}

export async function saveDraft(actor: Actor, id: string, draft: string): Promise<void> {
  const [row] = await db
    .update(emailThreads)
    .set({ draft: draft.slice(0, 20_000) })
    .where(eq(emailThreads.id, id))
    .returning({ id: emailThreads.id });
  if (!row) throw new UserError("That email no longer exists.");
}

export async function finishEmail(
  actor: Actor,
  id: string,
  outcome: "sent" | "dismissed",
  draft?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(emailThreads)
      .set({
        status: outcome,
        handledBy: actor.id,
        handledAt: new Date(),
        ...(draft !== undefined ? { draft: draft.slice(0, 20_000) } : {}),
      })
      .where(eq(emailThreads.id, id))
      .returning({ subject: emailThreads.subject });
    if (!row) throw new UserError("That email no longer exists.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "email",
      entityId: id,
      action: "status_change",
      summary: `${outcome === "sent" ? "Marked as sent" : "Dismissed"}: "${row.subject.slice(0, 80)}"`,
    });
  });
}

export async function reopenEmail(actor: Actor, id: string): Promise<void> {
  await db
    .update(emailThreads)
    .set({ status: "needs_you", handledBy: null, handledAt: null })
    .where(eq(emailThreads.id, id));
}

/** Writes the draft again (after adding knowledge, or choosing another bot). */
export async function redoDraft(actor: Actor, id: string, botId?: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(emailThreads)
      .set({ status: "new", error: null, ...(botId !== undefined ? { botId } : {}) })
      .where(eq(emailThreads.id, id))
      .returning({ id: emailThreads.id });
    if (!row) throw new UserError("That email no longer exists.");
    await enqueue("process_email", { emailId: id }, { tx, dedupeKey: `email:${id}` });
  });
  await kickJobs();
}
