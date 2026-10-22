import "server-only";
import { auditLog } from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/client";

/**
 * Audit writer: every mutation records who did what, in the same
 * transaction as the change. The table refuses UPDATE and DELETE (migration
 * 0002). Summaries name things by their own names, not people's details.
 */
export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "restore"
  | "purge"
  | "status_change"
  | "login"
  | "invite"
  | "role_change"
  | "settings_change"
  | "export"
  | "reply"
  | "handover";

export type AuditEntry = {
  actorUserId?: string | null;
  actorType?: "user" | "system" | "visitor";
  entityType: string;
  entityId?: string | null;
  action: AuditAction;
  summary: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
};

export async function writeAudit(tx: DbOrTx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    actorType: entry.actorType ?? "user",
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    action: entry.action,
    summary: entry.summary.slice(0, 500),
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: entry.ip ?? null,
  });
}
