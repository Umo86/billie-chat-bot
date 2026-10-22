/** Which files Billie reads, and how big. Pure, light: safe to import anywhere on the server. */
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

export const ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".csv",
  ".txt",
  ".md",
  ".html",
  ".htm",
];
