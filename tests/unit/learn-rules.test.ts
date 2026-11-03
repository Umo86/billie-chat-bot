import { describe, expect, it } from "vitest";
import { normaliseReply, replyPart, sameReply } from "@/lib/emails/learn-rules";

describe("comparing a sent reply with Billie's draft", () => {
  const draft =
    "Hi Sam,\n\nBuild-up starts on Tuesday 24 November at 10:30.\n\nKind regards,\nThe team";

  it("takes the reply above Outlook's quoted email", () => {
    const sent = `${draft}\n\n________________________________\nFrom: Sam Lee <sam@stands.test>\nSent: 02 November 2026 09:00\nSubject: Build-up`;
    expect(replyPart(sent)).toBe(draft);
    expect(replyPart("Thanks!\n\nOn Mon, 2 Nov 2026 at 09:00, Sam wrote:\n> When?")).toBe(
      "Thanks!",
    );
    expect(replyPart("Yes.\n-----Original Message-----\nFrom: x")).toBe("Yes.");
  });

  it("treats spacing and curly quotes as no change, and a new time as a change", () => {
    expect(sameReply(draft, draft.replace(/\n\n/g, "\n").replace("'", "’"))).toBe(true);
    expect(sameReply(draft, `  ${draft}  `)).toBe(true);
    expect(sameReply(draft, draft.replace("10:30", "11:00"))).toBe(false);
    expect(normaliseReply("A  b\r\n\r\n c")).toBe("A b\nc");
  });
});
