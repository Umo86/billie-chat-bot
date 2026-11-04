import { describe, expect, it } from "vitest";
import { forClaude, skipIncoming, THREAD_CONTEXT } from "@/lib/emails/mailbox-rules";
import { worthLearning } from "@/lib/emails/learn-rules";
import { suggestStraightAway } from "@/lib/conversations/handover";

/** Where Billie saves Claude calls and tokens without losing anything useful. */
describe("emails", () => {
  it("leaves newsletters and system notifications alone, as well as auto-replies", () => {
    const m = (from: string, subject = "Hello") => ({ from, subject, mailbox: "ops@m10.test" });
    for (const from of [
      "newsletter@venue.test",
      "marketing+uk@supplier.test",
      "notifications@eventbrite.test",
      "mailer@list.test",
    ])
      expect(skipIncoming(m(from))).toBe(true);
    expect(skipIncoming(m("sam@acme.test", "Out of office: back Monday"))).toBe(true);
    expect(skipIncoming(m("sam@acme.test"))).toBe(false);
    expect(skipIncoming(m("news.desk@paper.test"))).toBe(false);
  });

  it("sends Claude the email's own words, and only the start of the thread it quotes", () => {
    const older = `${"Earlier message about electrics. ".repeat(200)}`;
    const body = `Yes please, Friday works.\n\n________________\nFrom: Ops\nSent: Monday\n${older}`;
    const sent = forClaude(body);
    expect(sent.startsWith("Yes please, Friday works.\n\n[Earlier in the thread]\n")).toBe(true);
    expect(sent.length).toBeLessThan(THREAD_CONTEXT + 100);
    expect(forClaude("Can we park on site?")).toBe("Can we park on site?");
  });
});

describe("learning from what the team sent", () => {
  const draft =
    "Hi Sam,\n\nBuild-up starts on Tuesday 24 November at 10:30.\n\nKind regards,\nThe team";
  it("asks Claude only when a change could hold a fact", () => {
    expect(worthLearning(draft, draft.replace("Hi", "Hello").replace("Kind", "Best"))).toBe(false);
    expect(worthLearning(draft, draft.replace("10:30", "12:00"))).toBe(true);
    expect(worthLearning(draft, draft.replace("starts", "doesn't start"))).toBe(true);
    expect(worthLearning(draft, draft.replace("Tuesday", "Wednesday"))).toBe(true);
    expect(
      worthLearning(
        draft,
        `${draft}\n\nPlease bring your own trolleys and keep the gangways clear at all times.`,
      ),
    ).toBe(true);
  });
});

describe("suggested replies", () => {
  it("are written straight away only when Billie hadn't tried the knowledge already", () => {
    expect(suggestStraightAway("asked_for_person")).toBe(true);
    expect(suggestStraightAway("always_human")).toBe(true);
    for (const r of ["unknown", "thumbs_down", "ai_unavailable"] as const)
      expect(suggestStraightAway(r)).toBe(false);
  });
});
