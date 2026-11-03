/**
 * Comparing what the team sent with Billie's draft (pure). The sent reply
 * is the text above the quoted email; spacing, quote marks and line breaks
 * don't count as a change.
 */

const QUOTE_STARTS = [
  /^_{5,}\s*$/m, // Outlook: a line of underscores, then From: / Sent:
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^On .{4,120} wrote:\s*$/m,
  /^From:\s.+\n(?:.+\n){0,2}?Sent:\s/m,
];

/** The reply itself: the text above the quoted email. */
export function replyPart(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n");
  let cut = clean.length;
  for (const re of QUOTE_STARTS) {
    const m = re.exec(clean);
    if (m && m.index < cut) cut = m.index;
  }
  return clean.slice(0, cut).trim();
}

/** Text as compared: straight quotes, single spaces, no blank lines. */
export function normaliseReply(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[   ]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function sameReply(draft: string, sent: string): boolean {
  return normaliseReply(draft) === normaliseReply(replyPart(sent));
}
