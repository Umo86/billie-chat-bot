import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { passages, sources } from "@/lib/db/schema";
import { retrieve, SEND_ALL_CHARS } from "@/lib/knowledge/search";
import { deleteSource, restoreSource } from "@/lib/knowledge/sources";
import { addAndRead, addFixture, hasDb, makeBot, makeUser } from "../helpers/db";

describe.skipIf(!hasDb)("knowledge: reading files and searching (Postgres)", () => {
  it("reads a PDF page by page, labelled p. 1 and p. 2, with embeddings", async () => {
    const actor = await makeUser("editor");
    const { kb } = await makeBot();
    const id = await addFixture(actor, kb.id, "exhibitor-manual.pdf", "application/pdf");
    const src = await db.query.sources.findFirst({ where: eq(sources.id, id) });
    expect(src).toMatchObject({ status: "ready", passageCount: 2, error: null });
    const rows = await db
      .select()
      .from(passages)
      .where(eq(passages.sourceId, id))
      .orderBy(passages.ordinal);
    expect(rows.map((r) => r.label)).toEqual(["p. 1", "p. 2"]);
    expect(rows[1].text).toContain("Voyage Control");
    expect(rows.every((r) => Array.isArray(r.embedding) && r.embedding.length === 1024)).toBe(true);
  });

  it("reads Word headings, Excel sheets and CSV rows as readable records", async () => {
    const actor = await makeUser("editor");
    const { kb } = await makeBot();
    const docx = await addFixture(
      actor,
      kb.id,
      "badges-guide.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const xlsx = await addFixture(
      actor,
      kb.id,
      "furniture-prices.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const csv = await addFixture(actor, kb.id, "parking.csv", "text/csv");
    const text = async (id: string) =>
      (await db.select().from(passages).where(eq(passages.sourceId, id)))
        .map((p) => `${p.label} | ${p.text}`)
        .join("\n");
    expect(await text(docx)).toContain(
      "Badges | Each exhibiting company gets four exhibitor badges",
    );
    expect(await text(xlsx)).toContain("Sheet: Furniture | Item: Stool; Price: £45");
    expect(await text(csv)).toContain("Car park: East car park; Opens: 07:00; Price per day: £25");
  });

  it("says plainly when a file can't be read, without retrying", async () => {
    const actor = await makeUser("editor");
    const { kb } = await makeBot();
    const { putFile } = await import("@/lib/storage");
    const fileKey = await putFile("broken.pdf", Buffer.from("not a pdf"), "application/pdf");
    const id = await addAndRead(actor, kb.id, {
      kind: "file",
      name: "broken.pdf",
      fileKey,
      size: 9,
      mimeType: "application/pdf",
    });
    const src = await db.query.sources.findFirst({ where: eq(sources.id, id) });
    expect(src?.status).toBe("failed");
    expect(src?.error).toMatch(/couldn't be opened as a PDF/);
  });

  it("sends a small knowledge base whole, typed answers first, and leaves deleted sources out", async () => {
    const actor = await makeUser("editor");
    const { kb } = await makeBot();
    await addAndRead(actor, kb.id, {
      kind: "text",
      title: "Wi-Fi",
      body: "Free Wi-Fi covers all halls.",
    });
    const qa = await addAndRead(actor, kb.id, {
      kind: "qa",
      question: "Can we bring a forklift?",
      answer: "No, the official contractor provides forklifts.",
    });
    let found = await retrieve([kb.id], "anything");
    expect(found.map((p) => p.kind)).toEqual(["qa", "text"]);
    await deleteSource(actor, qa);
    found = await retrieve([kb.id], "anything");
    expect(found.map((p) => p.kind)).toEqual(["text"]);
    await restoreSource(actor, qa);
    expect((await retrieve([kb.id], "anything")).length).toBe(2);
  });

  it("searches a large knowledge base by keyword and meaning, best passage first", async () => {
    const actor = await makeUser("editor");
    const { kb } = await makeBot();
    const filler = Array.from(
      { length: 120 },
      (_, i) =>
        `Section ${i}. Stand cleaning, carpet colours and lighting rules for zone ${i} are listed in the appendix.`,
    ).join("\n\n");
    await addAndRead(actor, kb.id, {
      kind: "text",
      title: "General rules",
      body: `${filler}\n\n${filler}\n\n${filler}`,
    });
    await addAndRead(actor, kb.id, {
      kind: "text",
      title: "Deliveries",
      body: "Deliveries during build-up go to the hall loading bays. Every courier must book through Voyage Control.",
    });
    const size = (
      await db.select().from(passages).where(eq(passages.knowledgeBaseId, kb.id))
    ).reduce((n, p) => n + p.text.length, 0);
    expect(size).toBeGreaterThan(SEND_ALL_CHARS);
    const found = await retrieve([kb.id], "Where do deliveries go?");
    expect(found[0].sourceTitle).toBe("Deliveries");
    expect(found.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(14_000);
  });
});
