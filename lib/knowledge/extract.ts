import "server-only";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { Segment } from "./chunk";

/**
 * Turning files into labelled text (server-side). Labels say where a passage
 * came from, so answers can cite "p. 4" or "Sheet: Prices". Anything that
 * can't be read raises UnreadableFileError with a sentence a person can act
 * on (a scanned PDF needs text, a password must be removed, …).
 */
export class UnreadableFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableFileError";
  }
}

export const MAX_SOURCE_CHARS = 2_000_000;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export type FileKind = "pdf" | "docx" | "xlsx" | "csv" | "text" | "html";

export function fileKind(name: string, mime: string | null | undefined): FileKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const m = (mime ?? "").toLowerCase();
  if (ext === "pdf" || m === "application/pdf") return "pdf";
  if (ext === "docx" || m.includes("wordprocessingml")) return "docx";
  if (ext === "xlsx" || m.includes("spreadsheetml")) return "xlsx";
  if (ext === "csv" || m === "text/csv") return "csv";
  if (ext === "html" || ext === "htm" || m === "text/html") return "html";
  if (["txt", "md", "markdown"].includes(ext) || m.startsWith("text/")) return "text";
  return null;
}

export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md", ".html", ".htm"];

function clean(text: string): string {
  return text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

async function pdfSegments(bytes: Buffer): Promise<Segment[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let doc;
  try {
    // unpdf bundles pdf.js 6.x: past the 4.2.67 fix for CVE-2024-4367, with no eval code path at all.
    doc = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/password/i.test(msg)) {
      throw new UnreadableFileError("This PDF is password-protected. Save a copy without the password and add that.");
    }
    throw new UnreadableFileError("This file couldn't be opened as a PDF.");
  }
  const { text } = await extractText(doc, { mergePages: false });
  const pages = text.map((t, i) => ({ text: clean(t), label: `p. ${i + 1}` })).filter((p) => p.text);
  if (!pages.length) {
    throw new UnreadableFileError(
      "No text found: this looks like a scanned PDF. Export it from the original document, or paste the text instead.",
    );
  }
  return pages;
}

/** Headings start a new labelled segment; paragraphs, list items and table rows become lines. */
function htmlToSegments(html: string, fallbackLabel = ""): Segment[] {
  // linkedom is a light DOM for the server; it never runs scripts.
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const segments: Segment[] = [];
  let label = fallbackLabel;
  let lines: string[] = [];
  const flush = () => {
    const text = clean(lines.join("\n\n"));
    if (text) segments.push({ text, label });
    lines = [];
  };
  const blocks = document.body.querySelectorAll("h1,h2,h3,h4,p,li,tr,pre,blockquote,dt,dd");
  for (const el of blocks) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-4]$/.test(tag)) {
      flush();
      label = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || label;
      continue;
    }
    // Nested blocks (a <p> inside an <li>) are read once, from the outer one.
    if (el.parentElement?.closest("li,tr,pre,blockquote,dd") && tag !== "tr") continue;
    const text =
      tag === "tr"
        ? [...el.querySelectorAll("th,td")]
            .map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .join(" | ")
        : (el.textContent ?? "").replace(/[ \t]+/g, " ").trim();
    if (text) lines.push(tag === "li" ? `• ${text}` : text);
  }
  flush();
  if (!segments.length) {
    const text = clean(document.body.textContent ?? "");
    if (text) segments.push({ text, label: fallbackLabel });
  }
  return segments;
}

async function docxSegments(bytes: Buffer): Promise<Segment[]> {
  const mammoth = (await import("mammoth")).default;
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer: bytes }));
  } catch {
    throw new UnreadableFileError("This file couldn't be opened as a Word document (.docx).");
  }
  const segments = htmlToSegments(html);
  if (!segments.length) throw new UnreadableFileError("No text found in this Word document.");
  return segments;
}

/** Each row becomes "Header: value; Header: value" so a passage is a readable record. */
function rowsToText(header: string[], rows: string[][]): string[] {
  return rows
    .map((r) =>
      r
        .map((v, i) => {
          const value = v.trim();
          if (!value) return "";
          const h = (header[i] ?? "").trim();
          return h ? `${h}: ${value}` : value;
        })
        .filter(Boolean)
        .join("; "),
    )
    .filter(Boolean);
}

async function xlsxSegments(bytes: Buffer): Promise<Segment[]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new UnreadableFileError("This file couldn't be opened as an Excel workbook (.xlsx).");
  }
  const segments: Segment[] = [];
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = String(cell.text ?? "").replace(/\s+/g, " ");
      });
      rows.push(Array.from(cells, (c) => c ?? ""));
    });
    if (!rows.length) return;
    const [header, ...body] = rows;
    const lines = body.length ? rowsToText(header, body) : rowsToText([], [header]);
    if (lines.length) segments.push({ text: lines.join("\n\n"), label: `Sheet: ${ws.name}` });
  });
  if (!segments.length) throw new UnreadableFileError("No data found in this workbook.");
  return segments;
}

async function csvSegments(text: string): Promise<Segment[]> {
  const Papa = (await import("papaparse")).default;
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: true });
  const rows = parsed.data.filter((r) => Array.isArray(r));
  if (!rows.length) throw new UnreadableFileError("No rows found in this CSV file.");
  const [header, ...body] = rows;
  const lines = body.length ? rowsToText(header, body) : rowsToText([], [header]);
  return [{ text: lines.join("\n\n"), label: "" }];
}

function decodeText(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
}

export async function extractFile(
  bytes: Buffer,
  name: string,
  mime: string | null | undefined,
): Promise<Segment[]> {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new UnreadableFileError("This file is over 50 MB. Split it, or upload the sections people ask about.");
  }
  const kind = fileKind(name, mime);
  switch (kind) {
    case "pdf":
      return pdfSegments(bytes);
    case "docx":
      return docxSegments(bytes);
    case "xlsx":
      return xlsxSegments(bytes);
    case "csv":
      return csvSegments(decodeText(bytes));
    case "html":
      return htmlToSegments(decodeText(bytes));
    case "text": {
      const text = clean(decodeText(bytes));
      if (!text) throw new UnreadableFileError("This file is empty.");
      return [{ text, label: "" }];
    }
    default:
      throw new UnreadableFileError(
        "Billie reads PDF, Word (.docx), Excel (.xlsx), CSV and text files. Save this file as one of those.",
      );
  }
}

/** The readable article of a web page (menus, footers and adverts removed). */
export function webPageSegments(html: string, url: string): { title: string; segments: Segment[] } {
  const { document } = parseHTML(html);
  const pageTitle = (document.querySelector("title")?.textContent ?? "").trim();
  const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
  const segments = htmlToSegments(article?.content ?? html, "");
  const title = (article?.title || pageTitle || url).trim().slice(0, 200);
  return { title, segments };
}

/** Caps a source at MAX_SOURCE_CHARS, keeping whole segments where possible. */
export function capSegments(segments: Segment[]): { segments: Segment[]; truncated: boolean } {
  let total = 0;
  const out: Segment[] = [];
  for (const s of segments) {
    if (total + s.text.length > MAX_SOURCE_CHARS) {
      const room = MAX_SOURCE_CHARS - total;
      if (room > 500) out.push({ text: s.text.slice(0, room), label: s.label });
      return { segments: out, truncated: true };
    }
    out.push(s);
    total += s.text.length;
  }
  return { segments: out, truncated: false };
}
