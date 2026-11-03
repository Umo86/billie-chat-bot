import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { deflateRawSync } from "node:zlib";
import {
  checkUnpackedSize,
  emailsIn,
  ListError,
  looksInternal,
  MAX_EXHIBITORS,
  MAX_UNPACKED,
  readListFile,
  readRows,
  recordText,
} from "@/lib/exhibitors/list";

/** A one-file zip, as an .xlsx is: deflated, with sizes that may lie. */
function zipOf(name: string, data: Buffer, declared = data.length): Buffer {
  const packed = deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(declared, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(declared, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12);
  end.writeUInt32LE(local.length + n.length + packed.length, 16);
  return Buffer.concat([local, n, packed, central, n, end]);
}

describe("reading an exhibitor list", () => {
  it("finds email addresses in a cell", () => {
    expect(emailsIn("Sam@Acme.test")).toEqual(["sam@acme.test"]);
    expect(emailsIn("a@x.test; b@x.test, A@X.test")).toEqual(["a@x.test", "b@x.test"]);
    expect(emailsIn("Sam Patel <sam@acme.test>")).toEqual(["sam@acme.test"]);
    expect(emailsIn("not an email, n/a, @x.test, sam@")).toEqual([]);
  });

  it("finds the columns by their headings and keeps the rest as fields", () => {
    const read = readRows(
      ["Exhibitor Name", "Stand No.", "Main contact", "E-mail", "Stand type", "Electrics ordered"],
      [
        ["Acme Ltd", "B12", "Sam Patel", "sam@acme.test", "Shell scheme", "Yes"],
        ["Bolt & Co", "C4", "Jo Bloggs", "jo@bolt.test; ops@bolt.test", "Space only", ""],
        ["No Email Ltd", "D1", "Kim", "", "Shell scheme", "No"],
        ["", "", "", "", "", ""],
      ],
    );
    expect(read.found).toEqual({
      company: "Exhibitor Name",
      stand: "Stand No.",
      name: "Main contact",
      email: "E-mail",
    });
    expect(read.columns).toEqual(["Stand type", "Electrics ordered"]);
    expect(read.skipped).toBe(1); // the blank row isn't counted
    expect(read.exhibitors).toEqual([
      {
        company: "Acme Ltd",
        stand: "B12",
        name: "Sam Patel",
        emails: ["sam@acme.test"],
        fields: { "Stand type": "Shell scheme", "Electrics ordered": "Yes" },
      },
      {
        company: "Bolt & Co",
        stand: "C4",
        name: "Jo Bloggs",
        emails: ["jo@bolt.test", "ops@bolt.test"],
        // Empty cells aren't kept.
        fields: { "Stand type": "Space only" },
      },
    ]);
  });

  it("skips every row when there's no email column", () => {
    const read = readRows(["Company", "Stand"], [["Acme", "B12"]]);
    expect(read.found.email).toBeNull();
    expect(read.exhibitors).toEqual([]);
    expect(read.skipped).toBe(1);
  });

  it("stops at the most exhibitors a list can hold", () => {
    const rows = Array.from({ length: MAX_EXHIBITORS + 2 }, (_, i) => [`Co ${i}`, `x${i}@co.test`]);
    const read = readRows(["Company", "Email"], rows);
    expect(read.exhibitors).toHaveLength(MAX_EXHIBITORS);
    expect(read.skipped).toBe(2);
  });

  it("writes one exhibitor's record as lines to answer from", () => {
    expect(
      recordText({
        company: "Acme Ltd",
        stand: "B12",
        name: "",
        emails: ["sam@acme.test"],
        fields: { "Stand plan approved": "No", "Build-up slot": "Mon 08:00–12:00" },
      }),
    ).toBe(
      "Company: Acme Ltd\nStand: B12\nStand plan approved: No\nBuild-up slot: Mon 08:00–12:00",
    );
  });

  it("opens CSV files", async () => {
    const csv =
      '﻿Company,Stand,Email,Notes\n"Acme, Ltd",B12,sam@acme.test,"Corner, two open sides"\n';
    const { header, rows } = await readListFile(Buffer.from(csv), "exhibitors.CSV");
    expect(header).toEqual(["Company", "Stand", "Email", "Notes"]);
    expect(rows).toEqual([["Acme, Ltd", "B12", "sam@acme.test", "Corner, two open sides"]]);
  });

  it("opens the first sheet of an Excel workbook", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Exhibitors");
    ws.addRow(["Company", "Stand", "Email", "Stand type"]);
    ws.addRow(["Acme Ltd", "B12", "sam@acme.test", "Shell scheme"]);
    ws.addRow(["Bolt & Co", 7, "jo@bolt.test", null]);
    wb.addWorksheet("Notes").addRow(["Ignore me"]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const { header, rows } = await readListFile(bytes, "list.xlsx");
    expect(header).toEqual(["Company", "Stand", "Email", "Stand type"]);
    expect(rows).toEqual([
      ["Acme Ltd", "B12", "sam@acme.test", "Shell scheme"],
      ["Bolt & Co", "7", "jo@bolt.test"],
    ]);
  });

  it("says plainly what's wrong with a file it can't use", async () => {
    await expect(readListFile(Buffer.from("x"), "list.pdf")).rejects.toThrow(ListError);
    await expect(readListFile(Buffer.from("not a zip"), "list.xlsx")).rejects.toThrow(
      /couldn't be opened/,
    );
    await expect(readListFile(Buffer.from("Company,Email\n"), "list.csv")).rejects.toThrow(
      /No rows found/,
    );
  });

  it("won't open a small workbook that unpacks to something huge, even if it says it's small", () => {
    const huge = Buffer.alloc(MAX_UNPACKED + 1024, 0x41);
    expect(() => checkUnpackedSize(zipOf("xl/sharedStrings.xml", huge, 100))).toThrow(
      /too big once opened/,
    );
    expect(checkUnpackedSize(zipOf("xl/workbook.xml", Buffer.from("<x/>")))).toBe(4);
    expect(() => checkUnpackedSize(Buffer.from("not a zip at all, just text"))).toThrow(ListError);
  });

  it("reads only so many columns, and keeps headings short", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("List");
    ws.addRow(["Company", "Email", `Notes ${"x".repeat(300)}`]);
    ws.addRow(["Acme Ltd", "sam@acme.test", "Fine"]);
    ws.getRow(2).getCell(16_000).value = "far away";
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const { header, rows } = await readListFile(bytes, "list.xlsx");
    expect(header).toHaveLength(3);
    expect(rows[0].length).toBeLessThanOrEqual(200);
    expect(rows[0].join(" ")).not.toContain("far away");
    const read = readRows(header, rows);
    expect(read.columns[0]).toHaveLength(100);
  });

  it("starts columns that sound like the team's own notes hidden", () => {
    expect(looksInternal("Internal notes")).toBe(true);
    expect(looksInternal("Credit status")).toBe(true);
    expect(looksInternal("Sales comments")).toBe(true);
    expect(looksInternal("Stand type")).toBe(false);
    expect(looksInternal("Electrics ordered")).toBe(false);
  });
});
