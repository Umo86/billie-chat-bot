import { describe, expect, it } from "vitest";
import {
  nextStatus,
  botPaused,
  type ConversationEvent,
  type ConversationStatus,
} from "@/lib/conversations/status";

const STATUSES: ConversationStatus[] = [
  "bot",
  "waiting",
  "live",
  "collecting",
  "ticket",
  "replied",
  "closed",
];
const EVENTS: ConversationEvent[] = [
  "handover_live",
  "handover_offline",
  "details_left",
  "form_cancelled",
  "staff_replied",
  "hand_back",
  "visitor_wrote",
  "close",
];

// Every legal transition. Anything not listed must be refused.
const LEGAL: [ConversationStatus, ConversationEvent, ConversationStatus][] = [
  ["bot", "handover_live", "waiting"],
  ["bot", "handover_offline", "collecting"],
  ["bot", "staff_replied", "live"],
  ["bot", "visitor_wrote", "bot"],
  ["bot", "close", "closed"],
  ["waiting", "staff_replied", "live"],
  ["waiting", "handover_offline", "collecting"],
  ["waiting", "hand_back", "bot"],
  ["waiting", "visitor_wrote", "waiting"],
  ["waiting", "close", "closed"],
  ["live", "staff_replied", "live"],
  ["live", "hand_back", "bot"],
  ["live", "visitor_wrote", "live"],
  ["live", "close", "closed"],
  ["collecting", "details_left", "ticket"],
  ["collecting", "form_cancelled", "bot"],
  ["collecting", "staff_replied", "live"],
  ["collecting", "visitor_wrote", "collecting"],
  ["collecting", "close", "closed"],
  ["ticket", "staff_replied", "replied"],
  ["ticket", "visitor_wrote", "ticket"],
  ["ticket", "close", "closed"],
  ["replied", "staff_replied", "replied"],
  ["replied", "visitor_wrote", "bot"],
  ["replied", "close", "closed"],
  ["closed", "visitor_wrote", "bot"],
];

describe("conversation status machine", () => {
  it.each(LEGAL)("%s + %s → %s", (from, event, to) => {
    expect(nextStatus(from, event)).toBe(to);
  });

  it("refuses every other transition", () => {
    const legal = new Set(LEGAL.map(([f, e]) => `${f}|${e}`));
    for (const from of STATUSES) {
      for (const event of EVENTS) {
        if (legal.has(`${from}|${event}`)) continue;
        expect(nextStatus(from, event), `${from} + ${event}`).toBeNull();
      }
    }
  });

  it("pauses Billie while a person is on it", () => {
    expect(STATUSES.filter(botPaused)).toEqual(["waiting", "live", "collecting", "ticket"]);
  });
});
