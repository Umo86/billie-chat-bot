import { pgEnum } from "drizzle-orm/pg-core";

/** Admin: everything. Editor: bots and knowledge. Agent: Inbox and emails only. */
export const role = pgEnum("role", ["admin", "editor", "agent"]);
export const userStatus = pgEnum("user_status", ["active", "suspended"]);

export const audience = pgEnum("audience", ["visitors", "exhibitors"]);
export const botStatus = pgEnum("bot_status", ["draft", "live"]);
export const tone = pgEnum("tone", ["friendly", "formal", "brief"]);
/** fast = Haiku, thorough = Sonnet (lib/ai/models.ts). */
export const quality = pgEnum("quality", ["fast", "thorough"]);

export const sourceKind = pgEnum("source_kind", ["file", "text", "qa", "web"]);
/** queued → reading → ready | failed (lib/knowledge/status.ts). */
export const sourceStatus = pgEnum("source_status", ["queued", "reading", "ready", "failed"]);

/** Where a conversation came from. "try" = staff on the Try page (counted apart in reports). */
export const channel = pgEnum("channel", ["web", "hosted", "whatsapp", "try"]);

/**
 * bot → waiting (asked for a person, someone online) → live (staff replied) → bot (handed back)
 * bot → collecting (nobody online: details form shown) → ticket (details left) → replied
 * Any open state → closed. Pure transitions in lib/conversations/status.ts.
 */
export const conversationStatus = pgEnum("conversation_status", [
  "bot",
  "waiting",
  "live",
  "collecting",
  "ticket",
  "replied",
  "closed",
]);

export const handoverReason = pgEnum("handover_reason", [
  "unknown",
  "always_human",
  "asked_for_person",
  "thumbs_down",
  "ai_unavailable",
]);

export const messageRole = pgEnum("message_role", ["visitor", "bot", "agent", "system"]);

export const gapStatus = pgEnum("gap_status", ["open", "answered", "dismissed"]);

export const emailSource = pgEnum("email_source", ["outlook", "manual"]);
/** new → working → draft_ready | needs_you → sent | dismissed; failed when Claude or Outlook errs. */
export const emailStatus = pgEnum("email_status", [
  "new",
  "working",
  "draft_ready",
  "needs_you",
  "sent",
  "dismissed",
  "failed",
]);

export const jobStatus = pgEnum("job_status", ["queued", "running", "done", "failed"]);

export const actorType = pgEnum("actor_type", ["user", "system", "visitor"]);
export const auditAction = pgEnum("audit_action", [
  "create",
  "update",
  "delete",
  "restore",
  "purge",
  "status_change",
  "login",
  "invite",
  "role_change",
  "settings_change",
  "export",
  "reply",
  "handover",
]);
