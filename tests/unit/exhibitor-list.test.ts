import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  emailsIn,
  ListError,
  MAX_EXHIBITORS,
  readListFile,
  readRows,
  recordText,
} from "@/lib/exhibitors/list";

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
});
