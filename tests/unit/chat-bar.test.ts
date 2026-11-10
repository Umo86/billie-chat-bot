import { describe, expect, it } from "vitest";
import { barSpoken, barTopics, cleanTopics, shade } from "@/lib/chat/bar";

describe("the chat bar", () => {
  it("tidies topics: no blanks or repeats, at most six, sixty characters each", () => {
    expect(cleanTopics(["  speakers   and talks ", "", "Speakers and talks", "lunch"])).toEqual([
      "speakers and talks",
      "lunch",
    ]);
    expect(cleanTopics(Array.from({ length: 9 }, (_, i) => `topic ${i}`))).toHaveLength(6);
    expect(cleanTopics(["x".repeat(80)])[0]).toHaveLength(60);
  });

  it("says “anything” when there are no topics", () => {
    expect(barTopics([" "])).toEqual(["anything"]);
    expect(barSpoken("", [])).toBe("Ask me about anything");
  });

  it("reads the whole bar out at once for a screen reader", () => {
    expect(barSpoken("Ask me about", ["tickets", "parking", "talks"])).toBe(
      "Ask me about tickets, parking or talks",
    );
    expect(barSpoken("Ask about", ["tickets"])).toBe("Ask about tickets");
  });

  it("lightens and darkens a colour for the bar's gradient", () => {
    expect(shade("#808080", 0)).toBe("#808080");
    expect(shade("#000000", 0.5)).toBe("#808080");
    expect(shade("#ffffff", -0.5)).toBe("#808080");
    expect(shade("not a colour", 0.2)).toBe("not a colour");
  });
});
