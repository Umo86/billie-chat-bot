import { describe, expect, it } from "vitest";
import { ACTIONS, can, assertCan, ForbiddenError, type Actor, type Role } from "@/lib/authz";

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
