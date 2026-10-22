/**
 * The only authorisation module (Hall Pass rule): every server action and
 * every non-public read asks `can(actor, action)` first. Pure; the
 * permission matrix is tested row by row in tests/unit/authz.test.ts.
 *
 * Admin: everything. Editor: bots and knowledge, plus the Inbox and emails.
 * Agent: the Inbox and emails only.
 */
export type Role = "admin" | "editor" | "agent";

export type Actor = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "suspended";
};

export const ACTIONS = [
  "bots.view",
  "bots.edit",
  "bots.publish",
  "bots.delete",
  "knowledge.view",
  "knowledge.edit",
  "inbox.view",
  "inbox.reply",
  "emails.view",
  "emails.handle",
  "reports.view",
  "team.manage",
  "settings.manage",
  "data.export",
  "data.delete",
] as const;

export type Action = (typeof ACTIONS)[number];

const MATRIX: Record<Action, readonly Role[]> = {
  "bots.view": ["admin", "editor"],
  "bots.edit": ["admin", "editor"],
  "bots.publish": ["admin", "editor"],
  "bots.delete": ["admin"],
  "knowledge.view": ["admin", "editor"],
  "knowledge.edit": ["admin", "editor"],
  "inbox.view": ["admin", "editor", "agent"],
  "inbox.reply": ["admin", "editor", "agent"],
  "emails.view": ["admin", "editor", "agent"],
  "emails.handle": ["admin", "editor", "agent"],
  "reports.view": ["admin", "editor"],
  "team.manage": ["admin"],
  "settings.manage": ["admin"],
  "data.export": ["admin"],
  "data.delete": ["admin"],
};

export function can(actor: Actor | null | undefined, action: Action): boolean {
  if (!actor || actor.status !== "active") return false;
  return MATRIX[action].includes(actor.role);
}

export class ForbiddenError extends Error {
  constructor(public readonly action: Action) {
    super(`Not allowed: ${action}`);
    this.name = "ForbiddenError";
  }
}

/** Throws ForbiddenError unless the actor may do the action. */
export function assertCan(actor: Actor | null | undefined, action: Action): asserts actor is Actor {
  if (!can(actor, action)) throw new ForbiddenError(action);
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  editor: "Editor",
  agent: "Agent",
};

export const ROLE_HELP: Record<Role, string> = {
  admin: "Everything, including the team, settings and connections.",
  editor: "Builds bots and knowledge, and answers the Inbox and emails.",
  agent: "Answers the Inbox and emails only.",
};
