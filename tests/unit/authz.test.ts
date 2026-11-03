import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  assertCan,
  botScopeOf,
  can,
  canOnBot,
  ForbiddenError,
  scopeIds,
  type Actor,
  type Role,
} from "@/lib/authz";

const actor = (role: Role, status: Actor["status"] = "active"): Actor => ({
  id: "00000000-0000-0000-0000-000000000001",
  email: "a@example.com",
  name: "A",
  role,
  status,
});

// The permission matrix, one row per action: [admin, editor, agent].
const MATRIX: Record<(typeof ACTIONS)[number], [boolean, boolean, boolean]> = {
  "bots.view": [true, true, false],
  "bots.edit": [true, true, false],
  "bots.publish": [true, true, false],
  "bots.delete": [true, false, false],
  "knowledge.view": [true, true, false],
  "knowledge.edit": [true, true, false],
  "inbox.view": [true, true, true],
  "inbox.reply": [true, true, true],
  "emails.view": [true, true, true],
  "emails.handle": [true, true, true],
  "reports.view": [true, true, false],
  "reminders.send": [true, true, false],
  "team.manage": [true, false, false],
  "settings.manage": [true, false, false],
  "data.export": [true, false, false],
  "data.delete": [true, false, false],
};

describe("authz", () => {
  for (const action of ACTIONS) {
    const [admin, editor, agent] = MATRIX[action];
    it(`${action}: admin ${admin}, editor ${editor}, agent ${agent}`, () => {
      expect(can(actor("admin"), action)).toBe(admin);
      expect(can(actor("editor"), action)).toBe(editor);
      expect(can(actor("agent"), action)).toBe(agent);
    });
  }

  it("refuses suspended people and nobody, whatever the role", () => {
    for (const action of ACTIONS) {
      expect(can(actor("admin", "suspended"), action)).toBe(false);
      expect(can(null, action)).toBe(false);
      expect(can(undefined, action)).toBe(false);
    }
  });

  it("assertCan throws ForbiddenError naming the action", () => {
    expect(() => assertCan(actor("agent"), "bots.edit")).toThrow(ForbiddenError);
    expect(() => assertCan(actor("admin"), "bots.edit")).not.toThrow();
  });
});

describe("bots someone works on", () => {
  const MINE = "00000000-0000-0000-0000-00000000000a";
  const OTHER = "00000000-0000-0000-0000-00000000000b";

  it("admins work on every bot; editors and agents on the ones they're on", () => {
    expect(botScopeOf(actor("admin"), [])).toEqual({ all: true });
    const editor = botScopeOf(actor("editor"), [MINE]);
    expect(scopeIds(editor)).toEqual([MINE]);
    expect(scopeIds(botScopeOf(actor("admin"), [MINE]))).toBeNull();
  });

  it("an editor runs their bots and nobody else's", () => {
    const e = actor("editor");
    const scope = botScopeOf(e, [MINE]);
    for (const action of ["bots.edit", "bots.publish", "knowledge.edit", "inbox.reply"] as const) {
      expect(canOnBot(e, action, scope, MINE)).toBe(true);
      expect(canOnBot(e, action, scope, OTHER)).toBe(false);
    }
    expect(canOnBot(e, "bots.delete", scope, MINE)).toBe(false); // admins only, on any bot
    expect(canOnBot(e, "knowledge.edit", scope, null)).toBe(false); // an old shared base
  });

  it("an agent answers their bots' Inbox, requests and emails, and changes nothing else", () => {
    const a = actor("agent");
    const scope = botScopeOf(a, [MINE]);
    expect(canOnBot(a, "inbox.reply", scope, MINE)).toBe(true);
    expect(canOnBot(a, "emails.handle", scope, MINE)).toBe(true);
    expect(canOnBot(a, "inbox.reply", scope, OTHER)).toBe(false);
    expect(canOnBot(a, "bots.edit", scope, MINE)).toBe(false);
    expect(canOnBot(a, "knowledge.edit", scope, MINE)).toBe(false);
  });

  it("admins can do their actions on any bot, and on things with no bot", () => {
    const ad = actor("admin");
    const scope = botScopeOf(ad, []);
    expect(canOnBot(ad, "bots.delete", scope, OTHER)).toBe(true);
    expect(canOnBot(ad, "emails.handle", scope, null)).toBe(true);
    expect(canOnBot(actor("admin", "suspended"), "inbox.view", scope, OTHER)).toBe(false);
  });
});
