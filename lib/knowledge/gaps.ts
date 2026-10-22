/**
 * Grouping unanswered questions (pure): "Is there a crèche?" and "is there a
 * creche" are the same gap. The key is the lower-case wording without
 * accents, punctuation, filler words or a trailing question mark.
 */
const FILLER = new Set([
  "please",
  "hi",
  "hello",
  "hey",
  "thanks",
  "thank",
  "you",
  "a",
  "an",
  "the",
]);

export function questionKey(question: string): string {
  return (
    question
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[a-z0-9]+/g) ?? []
  )
    .filter((w) => !FILLER.has(w))
    .join(" ")
    .slice(0, 300);
}
