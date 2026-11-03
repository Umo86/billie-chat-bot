/**
 * The only authorisation module (Hall Pass rule): every server action and
 * every non-public read asks `can(actor, action)` first, and anything that
 * belongs to a bot also asks `canOnBot`. Pure; the permission matrix is
 * tested row by row in tests/unit/authz.test.ts.
 *
 * Admin: everything, on every bot. Editor: the bots they work on (settings,
 * knowledge, going live), plus those bots' Inbox, requests and emails.
 * Agent: the Inbox, requests and emails of the bots they work on. Admins
 * choose who works on each bot; whoever makes a bot works on it.
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
  "reminders.send",
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
  // Deadline reminders go to many exhibitors at once: people who run the bot.
  "reminders.send": ["admin", "editor"],
  "team.manage": ["admin"],
  "settings.manage": ["admin"],
  "data.export": ["admin"],
  "data.delete": ["admin"],
};

export function can(actor: Actor | null | undefined, action: Action): boolean {
  if (!actor || actor.status !== "active") return false;
  return MATRIX[action].includes(actor.role);
}

/** Which bots someone works on: every bot, or the ones they're on (bot_members). */
export type BotScope = { all: true } | { all: false; ids: ReadonlySet<string> };

/** Roles that work on every bot without being put on it. */
export const EVERY_BOT_ROLES: readonly Role[] = ["admin"];

export function roleWorksOnEveryBot(role: Role): boolean {
  return EVERY_BOT_ROLES.includes(role);
}

/** Admins work on every bot without being put on it. */
export function worksOnEveryBot(actor: Actor): boolean {
  return roleWorksOnEveryBot(actor.role);
}

export function botScopeOf(actor: Actor, memberOf: readonly string[]): BotScope {
  return worksOnEveryBot(actor) ? { all: true } : { all: false, ids: new Set(memberOf) };
}

/** May the actor do this to something of this bot? (No bot: admins only.) */
export function canOnBot(
  actor: Actor | null | undefined,
  action: Action,
  scope: BotScope,
  botId: string | null | undefined,
): boolean {
  if (!can(actor, action)) return false;
  if (scope.all) return true;
  return !!botId && scope.ids.has(botId);
}

/** The bots to show, for queries: null means every bot. */
export function scopeIds(scope: BotScope): string[] | null {
  return scope.all ? null : [...scope.ids];
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
  admin: "Everything, on every bot, including the team, settings and connections.",
  editor:
    "Builds and runs the bots they're on: knowledge, rules, going live, and their Inbox, requests and emails.",
  agent: "Answers the Inbox, requests and emails of the bots they're on.",
};
