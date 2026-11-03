import { describe, expect, it } from "vitest";
import { countMatches, matchSnippets, replaceAllText, splitQa } from "@/lib/knowledge/replace";

describe("find and replace in knowledge", () => {
  const text =
    "Email EventCreate at idealhomeshow@eventcreate.co.uk. EVENTCREATE answers within a day.";

  it("finds text whatever the capitals, and replaces it exactly as typed", () => {
    expect(countMatches(text, "eventcreate")).toBe(3);
    expect(replaceAllText(text, "idealhomeshow@eventcreate.co.uk", "ops@media10.test")).toBe(
      "Email EventCreate at ops@media10.test. EVENTCREATE answers within a day.",
    );
    expect(
      replaceAllText("EventCreate and EVENTCREATE", "eventcreate", "the Operations team"),
    ).toBe("the Operations team and the Operations team");
  });

  it("treats the text literally: no wildcards, no $ patterns", () => {
    expect(countMatches("Price £1,009.94 (3KW)", "(3KW)")).toBe(1);
    expect(countMatches("a.b axb", "a.b")).toBe(1);
    expect(replaceAllText("Call 01676 542616", "01676 542616", "$& $1 $$")).toBe("Call $& $1 $$");
    expect(replaceAllText("unchanged", "", "x")).toBe("unchanged");
  });

  it("shows short extracts before and after the change", () => {
    const [first, ...rest] = matchSnippets(text, "eventcreate", "Media10", 2);
    expect(first.before).toContain("Email EventCreate at idealhomeshow@");
    expect(first.after).toContain("Email Media10 at idealhomeshow@");
    expect(rest).toHaveLength(1);
    const long = `${"x".repeat(80)} needle ${"y".repeat(80)}`;
    const [s] = matchSnippets(long, "needle", "pin");
    expect(s.before.startsWith("…")).toBe(true);
    expect(s.after.endsWith("…")).toBe(true);
    expect(s.after).toContain(" pin ");
  });

  it("splits a typed answer back into its question and answer", () => {
    expect(splitQa("Q: When is build-up?\nA: Tuesday 24 November.\nFrom 10:30.")).toEqual({
      question: "When is build-up?",
      answer: "Tuesday 24 November.\nFrom 10:30.",
    });
    expect(splitQa("Just an answer")).toEqual({ question: "", answer: "Just an answer" });
  });
});
