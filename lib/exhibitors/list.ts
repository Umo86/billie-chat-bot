import { inflateRawSync } from "node:zlib";

/**
 * Reading an exhibitor list (pure, apart from opening the file): the team's
 * own spreadsheet, with a header row. Company, stand, contact name and email
 * columns are found by their headings; every other column is kept as it is
 * ("Stand type", "Electrics ordered", "Stand plan", "Build-up slot") for
 * signed-in exhibitors' answers and for deadline chasers.
 */

export type ListedExhibitor = {
  company: string;
  stand: string;
  name: string;
  emails: string[];
  fields: Record<string, string>;
};

export type ReadList = {
  exhibitors: ListedExhibitor[];
  /** The headings kept as fields, in order. */
  columns: string[];
  /** Rows with no usable email address. */
  skipped: number;
  /** Which heading was used for each of the four we look for. */
  found: {
    company: string | null;
    stand: string | null;
    name: string | null;
    email: string | null;
  };
};

export const MAX_EXHIBITORS = 5000;
const MAX_FIELDS = 40;
const MAX_VALUE = 500;
const MAX_HEADING = 100;
/** Columns read from each row: plenty for any list, and a wide sheet can't fill the memory. */
const MAX_COLUMNS = 200;
/** Rows read, blank and address-less ones included. */
const MAX_ROWS = MAX_EXHIBITORS * 3;
/** A workbook unpacked: an .xlsx is a zip, and a small one can unpack to gigabytes. */
export const MAX_UNPACKED = 40 * 1024 * 1024;

const HEADINGS = {
  company: [
    "company",
    "company name",
    "exhibitor",
    "exhibitor name",
    "organisation",
    "organization",
  ],
  stand: ["stand", "stand number", "stand no", "stand no.", "stand ref", "booth", "booth number"],
  name: ["name", "contact", "contact name", "full name", "main contact"],
  email: ["email", "e-mail", "email address", "contact email", "main contact email"],
} as const;

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

function headingKey(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ").replace(/[:*]$/, "");
}

/** Email addresses in a cell ("a@x.com; b@x.com", or "Sam <sam@x.com>"), lower case. */
export function emailsIn(cell: string): string[] {
  return [
    ...new Set(
      cell
        .split(/[,;\s]+/)
        .map((p) =>
          p
            .replace(/^[<(]+|[>)]+$/g, "")
            .trim()
            .toLowerCase(),
        )
        .filter((p) => EMAIL.test(p)),
    ),
  ];
}

export function readRows(header: string[], rows: string[][]): ReadList {
  const keys = header.map(headingKey);
  const col = (names: readonly string[]) => {
    const i = keys.findIndex((k) => names.includes(k));
    return i >= 0 ? i : null;
  };
  const at = {
    company: col(HEADINGS.company),
    stand: col(HEADINGS.stand),
    name: col(HEADINGS.name),
    email: col(HEADINGS.email),
  };
  const used = new Set(Object.values(at).filter((i): i is number => i !== null));
  const fieldCols = header
    .map((h, i) => ({ h: h.trim().slice(0, MAX_HEADING), i }))
    .filter(({ h, i }) => h && !used.has(i))
    .slice(0, MAX_FIELDS);
  const cell = (r: string[], i: number | null) =>
    i === null
      ? ""
      : String(r[i] ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_VALUE);

  const out: ListedExhibitor[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (!r.some((c) => String(c ?? "").trim())) continue; // a blank row
    const emails = at.email === null ? [] : emailsIn(String(r[at.email] ?? ""));
    if (!emails.length || out.length >= MAX_EXHIBITORS) {
      skipped++;
      continue;
    }
    const fields: Record<string, string> = {};
    for (const { h, i } of fieldCols) {
      const v = cell(r, i);
      if (v) fields[h] = v;
    }
    out.push({
      company: cell(r, at.company),
      stand: cell(r, at.stand),
      name: cell(r, at.name),
      emails,
      fields,
    });
  }
  return {
    exhibitors: out,
    columns: fieldCols.map((c) => c.h),
    skipped,
    found: {
      company: at.company === null ? null : header[at.company].trim(),
      stand: at.stand === null ? null : header[at.stand].trim(),
      name: at.name === null ? null : header[at.name].trim(),
      email: at.email === null ? null : header[at.email].trim(),
    },
  };
}

/** One exhibitor's record, as lines Billie answers from. */
export function recordText(e: ListedExhibitor): string {
  return [
    e.company ? `Company: ${e.company}` : null,
    e.stand ? `Stand: ${e.stand}` : null,
    e.name ? `Contact: ${e.name}` : null,
    ...Object.entries(e.fields).map(([k, v]) => `${k}: ${v}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Headings that sound like the team's own notes: hidden from Billie until someone ticks them. */
const INTERNAL =
  /\b(notes?|internal|private|confidential|credit|comments?|invoices?|balance|owed|debts?|arrears|payment status|account manager|sales)\b/i;

export function looksInternal(heading: string): boolean {
  return INTERNAL.test(heading);
}

export class ListError extends Error {}

/**
 * How big the zip unpacks to, checked by unpacking each part with a ceiling
 * (the sizes a zip declares can lie). Throws if it's over `limit`, or isn't a
 * plain zip.
 */
export function checkUnpackedSize(bytes: Buffer, limit = MAX_UNPACKED): number {
  const bad = () => new ListError("This file couldn't be opened as an Excel workbook (.xlsx).");
  // The end of the central directory: the last 22 bytes, or before a comment.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw bad();
  const entries = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (entries === 0xffff || at === 0xffffffff || entries > 2000) throw bad(); // zip64, or absurd
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) throw bad();
    const method = bytes.readUInt16LE(at + 10);
    const packed = bytes.readUInt32LE(at + 20);
    const nameLen = bytes.readUInt16LE(at + 28);
    const extraLen = bytes.readUInt16LE(at + 30);
    const commentLen = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    at += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw bad();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + packed > bytes.length) throw bad();
    const room = limit - total;
    let size: number;
    if (method === 0) size = packed;
    else if (method === 8) {
      try {
        size = inflateRawSync(bytes.subarray(start, start + packed), {
          maxOutputLength: room + 1,
        }).length;
      } catch (err) {
        if (err instanceof RangeError) size = room + 1;
        else throw bad();
      }
    } else throw bad();
    total += size;
    if (total > limit)
      throw new ListError(
        "That workbook is too big once opened. Save just the exhibitor list as a new file, or as CSV.",
      );
  }
  return total;
}

/** The header row and the rows of a CSV or Excel file. */
export async function readListFile(
  bytes: Buffer,
  fileName: string,
): Promise<{ header: string[]; rows: string[][] }> {
  const lower = fileName.toLowerCase();
  let table: string[][] = [];
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const Papa = (await import("papaparse")).default;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
    table = Papa.parse<string[]>(text, { skipEmptyLines: true, preview: MAX_ROWS + 1 })
      .data.filter(Array.isArray)
      .map((r) => r.slice(0, MAX_COLUMNS));
  } else if (lower.endsWith(".xlsx")) {
    checkUnpackedSize(bytes);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    } catch {
      throw new ListError("This file couldn't be opened as an Excel workbook (.xlsx).");
    }
    const ws = wb.worksheets[0];
    // Cell by cell up to the column cap: a stray cell far to the right can't make millions.
    const last = Math.min(ws?.rowCount ?? 0, MAX_ROWS + 1);
    for (let i = 1; i <= last; i++) {
      const row = ws.getRow(i);
      const width = Math.min(row.cellCount, MAX_COLUMNS);
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) cells.push(String(row.getCell(c).text ?? ""));
      if (cells.some((c) => c.trim())) table.push(cells);
    }
  } else {
    throw new ListError("Upload the list as an Excel (.xlsx) or CSV file.");
  }
  const [header, ...rows] = table;
  if (!header?.length || !rows.length)
    throw new ListError("No rows found. The first row should be the column headings.");
  return { header: header.map((h) => String(h ?? "")), rows };
}
