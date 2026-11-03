import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { aiUsage, bots, conversations, emailThreads, gaps } from "@/lib/db/schema";
import { reportRange, showReport } from "@/lib/reports/show-report";
import { pdfSafe, showReportPdf } from "@/lib/reports/show-report-pdf";
import { hasDb, makeBot } from "../helpers/db";

describe("the end-of-show report", () => {
  it("covers the show days, or the days asked for, or the last 30", () => {
    const show = { showStartsOn: "2027-03-08", showEndsOn: "2027-03-12" };
    expect(reportRange(show, {}, "2027-03-20")).toEqual({
      from: "2027-03-08",
      to: "2027-03-12",
      usesShowDays: true,
    });
    expect(reportRange(show, { from: "2027-03-01", to: "2027-03-02" })).toMatchObject({
      from: "2027-03-01",
      to: "2027-03-02",
      usesShowDays: false,
    });
    // Nonsense days are ignored; a long range is cut.
    expect(reportRange(show, { from: "2027-03-12", to: "2027-03-01" }).from).toBe("2027-03-08");
    expect(reportRange(show, { from: "2026-01-01", to: "2027-12-31" }).to).toBe("2026-04-30");
    expect(reportRange({ showStartsOn: null, showEndsOn: null }, {}, "2026-11-03")).toEqual({
      from: "2026-10-05",
      to: "2026-11-03",
      usesShowDays: false,
    });
  });

  it("makes text safe for the PDF's font", () => {
    expect(pdfSafe("Şişli İstanbul, Gaziantep çiğköfte")).toBe(
      "Sisli Istanbul, Gaziantep çigköfte",
    );
    expect(pdfSafe("Café — “quoted” £5 €3 🎉 ok")).toBe("Café — “quoted” £5 €3 ok");
  });
});

describe.skipIf(!hasDb)("the end-of-show report (Postgres)", () => {
  it("counts the show days, and makes a PDF of them", async () => {
    const { bot } = await makeBot({ name: "Report Bot" });
    await db
      .update(bots)
      .set({ showName: "UKCW 2027", showStartsOn: "2027-06-07", showEndsOn: "2027-06-09" })
      .where(eq(bots.id, bot.id));
    const at = (iso: string) => new Date(iso);
    await db.insert(conversations).values([
      {
        botId: bot.id,
        channel: "web",
        firstQuestion: "Where is Hall 3?",
        createdAt: at("2027-06-07T09:00:00Z"),
      },
      {
        botId: bot.id,
        channel: "web",
        firstQuestion: "where is hall 3",
        createdAt: at("2027-06-08T09:00:00Z"),
      },
      {
        botId: bot.id,
        channel: "whatsapp",
        firstQuestion: "Refund please",
        handoverAt: at("2027-06-08T10:00:00Z"),
        handoverReason: "asked_for_person",
        createdAt: at("2027-06-08T09:30:00Z"),
      },
      // 23:30 UTC on the 9th is 00:30 on the 10th in the UK: after the show.
      {
        botId: bot.id,
        channel: "web",
        firstQuestion: "Late",
        createdAt: at("2027-06-09T23:30:00Z"),
      },
      {
        botId: bot.id,
        channel: "try",
        firstQuestion: "A test",
        createdAt: at("2027-06-08T12:00:00Z"),
      },
    ]);
    await db.insert(emailThreads).values({
      source: "manual",
      botId: bot.id,
      subject: "Badges",
      body: "?",
      status: "draft_ready",
      createdAt: at("2027-06-08T08:00:00Z"),
    });
    await db.insert(gaps).values({
      botId: bot.id,
      questionKey: `wifi-${randomUUID()}`,
      question: "Is there Wi-Fi in Hall 2?",
      askCount: 4,
      lastAskedAt: at("2027-06-08T15:00:00Z"),
    });
    await db.insert(aiUsage).values({
      day: "2027-06-08",
      scope: `bot:${bot.id}`,
      model: "claude-haiku-5-5",
      requests: 3,
      costMicros: 3_000,
    });
    const fresh = (await db.query.bots.findFirst({ where: eq(bots.id, bot.id) }))!;
    const range = reportRange(fresh, {});
    const r = (await showReport(bot.id, range, { withCost: true }))!;
    expect(r).toMatchObject({
      chats: 3,
      alonePct: 67,
      handedOver: 1,
      whatsapp: 1,
      emails: 1,
      emailsDrafted: 1,
      costMicros: 3_000,
      costPerChatMicros: 1_000,
      hours: 0.5, // 2 chats alone (8 min) + 1 email (8 min)
    });
    expect(r.days).toEqual([
      { day: "2027-06-07", chats: 1, handedOver: 0 },
      { day: "2027-06-08", chats: 2, handedOver: 1 },
    ]);
    expect(r.mostAsked[0]).toEqual({ question: "Where is Hall 3?", times: 2 });
    expect(r.reasons).toEqual([{ label: "Asked for a person", n: 1 }]);
    expect(r.couldntAnswer.map((g) => g.question)).toEqual(["Is there Wi-Fi in Hall 2?"]);
    // Without the cost for people who don't see it.
    expect((await showReport(bot.id, range, { withCost: false }))!.costMicros).toBeNull();

    const pdf = Buffer.from(await showReportPdf(r));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);
    // Plenty to say still fits: more pages, not cut off.
    const long = await showReportPdf({
      ...r,
      mostAsked: Array.from({ length: 10 }, (_, i) => ({
        question: `Question ${i} ${"word ".repeat(40)}`,
        times: 3,
      })),
      couldntAnswer: Array.from({ length: 10 }, (_, i) => ({
        id: `g${i}`,
        question: `Gap ${i} ${"word ".repeat(30)}`,
        askCount: 2,
      })),
      days: Array.from({ length: 30 }, (_, i) => ({
        day: `2027-06-${String(i + 1).padStart(2, "0")}`,
        chats: i,
        handedOver: 0,
      })),
    });
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(long)).getPageCount()).toBeGreaterThan(1);
  });
});
