import { describe, expect, it } from "vitest";
import {
  ANY_ANSWER,
  columnValues,
  daysLeft,
  daysUntil,
  draftFrom,
  fillIn,
  guessDone,
  isDone,
  unknownPlaceholders,
} from "@/lib/exhibitors/deadline-rules";

describe("deadline rules", () => {
  it("counts someone as done by their answer in the column", () => {
    const f = { "Stand plan approved": " Yes ", Nameboard: "", Electrics: "12/01/2027" };
    expect(isDone(f, "Stand plan approved", ["yes", "approved"])).toBe(true);
    expect(isDone(f, "Stand plan approved", ["approved"])).toBe(false);
    // No answer is never done, even with "any answer".
    expect(isDone(f, "Nameboard", [ANY_ANSWER])).toBe(false);
    expect(isDone(f, "Missing column", ["yes"])).toBe(false);
    expect(isDone(f, "Electrics", [ANY_ANSWER])).toBe(true);
  });

  it("lists each column's answers, most common first, ignoring case", () => {
    const rows: { fields: Record<string, string> }[] = [
      { fields: { Plan: "Yes" } },
      { fields: { Plan: "yes" } },
      { fields: { Plan: "No" } },
      { fields: {} },
    ];
    expect(columnValues(rows, ["Plan"])).toEqual({
      Plan: [
        { value: "Yes", count: 2 },
        { value: "", count: 1 },
        { value: "No", count: 1 },
      ],
    });
  });

  it("guesses which answers mean done", () => {
    expect(
      guessDone([
        { value: "Yes", count: 10 },
        { value: "No", count: 4 },
        { value: "Approved", count: 2 },
        { value: "", count: 3 },
      ]),
    ).toEqual(["yes", "approved"]);
    // Mostly dates: any answer counts.
    expect(
      guessDone([
        { value: "12/01/2027", count: 5 },
        { value: "2027-01-14", count: 2 },
        { value: "TBC", count: 1 },
      ]),
    ).toEqual([ANY_ANSWER]);
    expect(guessDone([{ value: "", count: 9 }])).toEqual([]);
  });

  it("fills in each exhibitor's details, with plain fallbacks", () => {
    const text = "Hi {first_name}, {company} ({stand}) still needs to send the plan.";
    expect(fillIn(text, { name: "Sam Patel", company: "Acme Ltd", stand: "B12" })).toBe(
      "Hi Sam, Acme Ltd (stand B12) still needs to send the plan.",
    );
    expect(fillIn(text, { name: "", company: "", stand: "" })).toBe(
      "Hi there, your company (your stand) still needs to send the plan.",
    );
  });

  it("finds placeholders Billie can't fill in", () => {
    expect(unknownPlaceholders("Hi {first_name}, {company} {stand}")).toEqual([]);
    expect(unknownPlaceholders("Due {deadline} for {name} and {name}")).toEqual([
      "{deadline}",
      "{name}",
    ]);
    // Not placeholders: empty or spaced braces.
    expect(unknownPlaceholders("a {} b { x }")).toEqual([]);
  });

  it("works out the reminder day and the days left in UK dates", () => {
    expect(draftFrom("2027-03-01", 7)).toBe("2027-02-22");
    expect(draftFrom("2027-03-01", 0)).toBeNull();
    expect(daysUntil("2027-03-01", "2027-02-27")).toBe(2);
    expect(daysUntil("2027-03-01", "2027-03-03")).toBe(-2);
    expect([0, 1, 12, -1, -3].map(daysLeft)).toEqual([
      "today",
      "tomorrow",
      "in 12 days",
      "passed yesterday",
      "passed 3 days ago",
    ]);
  });
});
