import { describe, expect, it } from "vitest";
import { describeHours, withinHours, validTime } from "@/lib/conversations/hours";
import {
  afterAnswer,
  afterRating,
  handoverRoute,
  handoverLine,
} from "@/lib/conversations/handover";
import { londonParts } from "@/lib/time";

const weekdays = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30" };

describe("team hours (UK time)", () => {
  it("handles British Summer Time: 08:30 UTC in July is 09:30 in London", () => {
    const july = new Date("2026-07-15T08:30:00Z"); // a Wednesday
    expect(londonParts(july)).toMatchObject({ day: 3, minutes: 9 * 60 + 30 });
    expect(withinHours(weekdays, july)).toBe(true);
  });

  it("handles GMT: 08:30 UTC in January is 08:30 in London, before opening", () => {
    expect(withinHours(weekdays, new Date("2026-01-14T08:30:00Z"))).toBe(false);
  });

  it("closes at the end time and on days off", () => {
    expect(withinHours(weekdays, new Date("2026-01-14T17:30:00Z"))).toBe(false);
    expect(withinHours(weekdays, new Date("2026-01-17T12:00:00Z"))).toBe(false); // Saturday
  });

  it("treats broken times as closed", () => {
    expect(
      withinHours({ days: [3], start: "nonsense", end: "17:00" }, new Date("2026-01-14T12:00:00Z")),
    ).toBe(false);
    expect(validTime("09:00")).toBe(true);
    expect(validTime("24:00")).toBe(false);
  });

  it("describes runs of days", () => {
    expect(describeHours(weekdays)).toBe("Mon–Fri, 09:00–17:30");
    expect(describeHours({ days: [1, 3, 6], start: "10:00", end: "16:00" })).toBe(
      "Mon, Wed, Sat, 10:00–16:00",
    );
    expect(describeHours({ days: [6, 0], start: "10:00", end: "16:00" })).toBe(
      "Sat, Sun, 10:00–16:00",
    );
    expect(describeHours({ days: [], start: "10:00", end: "16:00" })).toBe("");
  });
});

describe("handover rules", () => {
  it("hands over straight away for always-human topics and requests for a person", () => {
    expect(afterAnswer("always_human")).toEqual({ kind: "now", reason: "always_human" });
    expect(afterAnswer("asked_for_person")).toEqual({ kind: "now", reason: "asked_for_person" });
  });

  it("offers the team when Billie has no answer, and does nothing otherwise", () => {
    expect(afterAnswer("unknown")).toEqual({ kind: "offer", reason: "unknown" });
    expect(afterAnswer("none")).toEqual({ kind: "none" });
  });

  it("offers the team after two thumbs-down in a row", () => {
    expect(afterRating(1)).toEqual({ kind: "none" });
    expect(afterRating(2)).toEqual({ kind: "offer", reason: "thumbs_down" });
  });

  it("goes live only when someone is available", () => {
    expect(handoverRoute(0)).toBe("details");
    expect(handoverRoute(2)).toBe("live");
    expect(handoverLine("live", "unknown")).toMatch(/Connecting you/);
    expect(handoverLine("details", "always_human")).toMatch(/handles this personally/);
  });
});
