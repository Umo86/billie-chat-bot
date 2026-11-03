/**
 * Find and replace in knowledge (pure; tested in tests/unit/knowledge-replace.test.ts).
 * The text is matched literally, ignoring capitals: "EventCreate" also finds
 * "eventcreate". The replacement goes in exactly as typed.
 */

function pattern(find: string): RegExp {
  return new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

export function countMatches(text: string, find: string): number {
  if (!find) return 0;
  return text.match(pattern(find))?.length ?? 0;
}

/** Every match replaced with the text as typed (no $1-style patterns). */
export function replaceAllText(text: string, find: string, replace: string): string {
  if (!find) return text;
  return text.replace(pattern(find), () => replace);
}

export type Snippet = { before: string; after: string };

/** Up to `max` short extracts around matches, before and after the change. */
export function matchSnippets(text: string, find: string, replace: string, max = 3): Snippet[] {
  if (!find) return [];
  const out: Snippet[] = [];
  const re = pattern(find);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < max) {
    const start = Math.max(0, m.index - 50);
    const end = Math.min(text.length, m.index + m[0].length + 50);
    const lead = (start > 0 ? "…" : "") + text.slice(start, m.index);
    const tail = text.slice(m.index + m[0].length, end) + (end < text.length ? "…" : "");
    const flat = (s: string) => s.replace(/\s+/g, " ");
    out.push({ before: flat(lead + m[0] + tail), after: flat(lead + replace + tail) });
  }
  return out;
}

/** A typed answer's text ("Q: …\nA: …") split back into its question and answer. */
export function splitQa(body: string): { question: string; answer: string } {
  const m = /^Q: ([\s\S]*?)\nA: ([\s\S]*)$/.exec(body);
  if (m) return { question: m[1].trim(), answer: m[2].trim() };
  return { question: "", answer: body.trim() };
}
