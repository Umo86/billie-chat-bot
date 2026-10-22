/**
 * Content Security Policy pieces shared by next.config.ts (staff pages) and
 * proxy.ts (the chat frame, whose frame-ancestors depend on each bot's
 * allowed websites). Kept free of imports so next.config.ts can load it.
 */
const BLOB = "https://*.blob.vercel-storage.com";

export const baseCsp: readonly string[] = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  `img-src 'self' data: blob: ${BLOB}`,
  // Browser → Vercel Blob direct uploads (large exhibitor manuals).
  `connect-src 'self' https://vercel.com ${BLOB}`,
  // The Try page shows the chat frame from this same app.
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

/** The full policy with the given frame-ancestors list (e.g. "'self' https://example.com"). */
export function cspWithAncestors(ancestors: string): string {
  return [...baseCsp, `frame-ancestors ${ancestors}`].join("; ");
}
