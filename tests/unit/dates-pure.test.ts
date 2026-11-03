import { describe, expect, it } from "vitest";
import { dateSnippet, findDates } from "@/lib/knowledge/dates";

const texts = (s: string) => findDates(s).map((d) => d.text);

describe("finding dates to check in a copied bot", () => {
  it("finds British dates with or without the day and year", () => {
    expect(
      texts(
        "Space only build-up starts on Tuesday 24 November at 10:30. The early bird deadline is 26 October 2026.",
      ),
    ).toEqual(["Tuesday 24 November", "26 October 2026"]);
    expect(texts("Stand plans by the 9th of November, please.")).toEqual(["9th of November"]);
  });

  it("finds American order, numeric dates, month and year, and a year on its own", () => {
    expect(texts("Doors open March 8th, 2027.")).toEqual(["March 8th, 2027"]);
    expect(texts("Forms due 24/11/2026 or 2026-11-20.")).toEqual(["24/11/2026", "2026-11-20"]);
    expect(texts("Ideal Home Show Christmas 2026 at Olympia")).toEqual(["2026"]);
    expect(texts("Rebooking opens in January 2027.")).toEqual(["January 2027"]);
  });

  it("never splits one date into two, and ignores times and prices", () => {
    expect(texts("Breakdown ends 22:00 on Sunday 29 November 2026; electrics cost £210.")).toEqual([
      "Sunday 29 November 2026",
    ]);
    expect(texts("No dates here: call 07799 606 262 or stand N3-210.")).toEqual([]);
  });

  it("shows a short piece of the text around a date", () => {
    const text = `${"x ".repeat(60)}build-up starts on Tuesday 24 November at 10:30${" y".repeat(60)}`;
    const [d] = findDates(text);
    const snippet = dateSnippet(text, d, 20);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("Tuesday 24 November at 10:30");
  });
});
