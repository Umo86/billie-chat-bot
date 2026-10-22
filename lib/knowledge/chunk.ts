/**
 * Splitting extracted text into passages (pure). A passage is short enough
 * for search to point at one fact and for an answer to cite it, and keeps
 * the label of where it came from (a page, a sheet, a heading).
 */
export type Segment = { text: string; label: string };
export type Chunk = { text: string; label: string };

export const MAX_PASSAGE = 1100;
const MIN_TAIL = 200;

function normaliseParagraphs(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/ *\n */g, "\n")
        .trim(),
    )
    .filter(Boolean);
}

function splitLong(p: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const sentence of p.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > max) {
      if (cur) out.push(cur);
      cur = "";
      for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + 1 + sentence.length > max) {
      out.push(cur);
      cur = sentence;
    } else {
      cur = cur ? `${cur} ${sentence}` : sentence;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Paragraph-aware passages of at most `max` characters, never crossing a label boundary. */
export function chunkSegments(segments: Segment[], max = MAX_PASSAGE): Chunk[] {
  const out: Chunk[] = [];
  for (const seg of segments) {
    const pieces = normaliseParagraphs(seg.text).flatMap((p) =>
      p.length > max ? splitLong(p, max) : [p],
    );
    let cur = "";
    const flush = () => {
      if (cur.trim()) out.push({ text: cur.trim(), label: seg.label });
      cur = "";
    };
    for (const piece of pieces) {
      if (cur && cur.length + 2 + piece.length > max) flush();
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
    // A very short tail joins the passage before it when they share a label.
    if (cur.trim() && cur.length < MIN_TAIL) {
      const prev = out.at(-1);
      if (prev && prev.label === seg.label && prev.text.length + 2 + cur.length <= max * 1.2) {
        prev.text = `${prev.text}\n\n${cur.trim()}`;
        cur = "";
      }
    }
    flush();
  }
  return out;
}

export function totalChars(chunks: { text: string }[]): number {
  return chunks.reduce((n, c) => n + c.text.length, 0);
}
