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
    .map((h, i) => ({ h: h.trim(), i }))
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

export class ListError extends Error {}

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
    table = Papa.parse<string[]>(text, { skipEmptyLines: true }).data.filter(Array.isArray);
  } else if (lower.endsWith(".xlsx")) {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    } catch {
      throw new ListError("This file couldn't be opened as an Excel workbook (.xlsx).");
    }
    const ws = wb.worksheets[0];
    ws?.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (c, i) => {
        cells[i - 1] = String(c.text ?? "");
      });
      table.push(Array.from(cells, (c) => c ?? ""));
    });
  } else {
    throw new ListError("Upload the list as an Excel (.xlsx) or CSV file.");
  }
  const [header, ...rows] = table;
  if (!header?.length || !rows.length)
    throw new ListError("No rows found. The first row should be the column headings.");
  return { header: header.map((h) => String(h ?? "")), rows };
}
