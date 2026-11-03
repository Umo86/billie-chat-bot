import { describe, expect, it } from "vitest";
import {
  buildPairs,
  cleanText,
  mergeFound,
  worthOffering,
  type PastMessage,
} from "@/lib/emails/history-rules";

const BOX = "ukcw@media-ten.test";
const msg = (
  conversationId: string,
  from: string,
  at: string,
  text: string,
  subject = "Question",
): PastMessage => ({ conversationId, from, at, subject, text });

describe("learning from past emails", () => {
  it("pairs each reply with the email it answered", () => {
    const inbound = [
      msg(
        "c1",
        "sam@acme.test",
        "2026-05-01T09:00:00Z",
        "When can we collect our badges?",
        "Badges",
      ),
      msg("c1", "sam@acme.test", "2026-05-03T09:00:00Z", "Thanks so much, that's great!", "Badges"),
      msg("c2", "no-reply@portal.test", "2026-05-02T09:00:00Z", "Your order is confirmed."),
      msg(
        "c3",
        "jo@bolt.test",
        "2026-05-02T10:00:00Z",
        "Out of office until Monday",
        "Automatic reply: hi",
      ),
      msg("c4", BOX, "2026-05-02T11:00:00Z", "Internal note from the mailbox itself."),
    ];
    const sent = [
      msg(
        "c1",
        BOX,
        "2026-05-01T12:00:00Z",
        "Badges can be collected from the north entrance from 8am.",
      ),
      // A second reply to the same email adds nothing.
      msg("c1", BOX, "2026-05-01T12:05:00Z", "Also: bring photo ID to collect the badges."),
      msg("c2", BOX, "2026-05-02T12:00:00Z", "Thanks, we've noted your order."),
      msg("c9", BOX, "2026-05-02T12:00:00Z", "A reply to something we never saw."),
    ];
    const pairs = buildPairs(sent, inbound, BOX);
    expect(pairs).toEqual([
      {
        subject: "Badges",
        asked: "When can we collect our badges?",
        replied: "Also: bring photo ID to collect the badges.",
      },
    ]);
  });

  it("keeps only the person's own words", () => {
    expect(
      cleanText(
        "Hi team,\nWhen does build-up start?\n\n\n\nThanks\n-- \nSam Patel\n07700 900123\n> On Monday you wrote:\n",
      ),
    ).toBe("Hi team,\nWhen does build-up start?\n\nThanks");
    expect(cleanText("Yes, from 8am.\nFrom: Sam <sam@acme.test>\nSent: Monday\nOld stuff")).toBe(
      "Yes, from 8am.",
    );
  });

  it("counts the same question from different batches together", () => {
    const merged = mergeFound([
      [
        { question: "When can we collect badges?", answer: "From 8am.", count: 3 },
        { question: "Where do we park?", answer: "Car park B.", count: 1 },
      ],
      [
        {
          question: "when can we collect badges",
          answer: "From 8am at the north entrance.",
          count: 5,
        },
      ],
    ]);
    expect(merged).toEqual([
      expect.objectContaining({
        question: "when can we collect badges",
        answer: "From 8am at the north entrance.",
        count: 8,
      }),
      expect.objectContaining({ question: "Where do we park?", count: 1 }),
    ]);
    expect(worthOffering(merged).map((f) => f.count)).toEqual([8]);
    // When nothing came up twice, the top few are still offered.
    expect(worthOffering(merged.slice(1))).toHaveLength(1);
  });
});
