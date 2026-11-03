/**
 * The "Billie is learning" panel shown after an upload (pure; tested in
 * tests/unit/knowledge-pure.test.ts): which state to show and what to say.
 * The panel asks for fresh statuses every couple of seconds until each file
 * is ready or couldn't be read.
 */
export type LearningStatus = "queued" | "reading" | "ready" | "failed";

export type LearningItem = {
  sourceId: string;
  name: string;
  status: LearningStatus;
  passages: number;
  error: string | null;
};

export type FreshStatus = {
  id: string;
  status: LearningStatus;
  passageCount: number;
  error: string | null;
};

export type LearningPhase = "learning" | "ready" | "failed";

/** How often the panel asks how the reading is going. */
export const LEARNING_POLL_MS = 2000;
/** After this long, the panel says it's taking longer than usual. */
export const LEARNING_SLOW_MS = 90_000;

export function stillLearning(item: { status: LearningStatus }): boolean {
  return item.status === "queued" || item.status === "reading";
}

/** Learning while a file is uploading or being read; ready once any file was learned. */
export function learningPhase(items: LearningItem[], uploading = false): LearningPhase {
  if (uploading || items.some(stillLearning)) return "learning";
  return items.some((i) => i.status === "ready") ? "ready" : "failed";
}

/** "Learned 128 passages from Exhibitor manual.pdf." or "… from 3 files." */
export function learnedSummary(items: LearningItem[]): string {
  const ready = items.filter((i) => i.status === "ready");
  const total = ready.reduce((sum, i) => sum + i.passages, 0);
  const from = ready.length === 1 ? ready[0].name : `${ready.length} files`;
  return `Learned ${total} ${total === 1 ? "passage" : "passages"} from ${from}.`;
}

/** "a.pdf", "a.pdf and b.pdf", "a.pdf, b.pdf and c.pdf". */
export function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Applies fresh statuses; a file removed meanwhile can't finish, so it shows as not read. */
export function mergeStatuses(items: LearningItem[], fresh: FreshStatus[]): LearningItem[] {
  const byId = new Map(fresh.map((f) => [f.id, f]));
  return items.map((item) => {
    if (!stillLearning(item)) return item;
    const f = byId.get(item.sourceId);
    if (!f)
      return { ...item, status: "failed", error: "This file was removed before Billie finished." };
    return { ...item, status: f.status, passages: f.passageCount, error: f.error };
  });
}
