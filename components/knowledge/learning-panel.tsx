"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sourceStatusAction } from "@/app/actions/knowledge";
import {
  LEARNING_POLL_MS,
  LEARNING_SLOW_MS,
  learnedSummary,
  learningPhase,
  mergeStatuses,
  namesList,
  stillLearning,
  type LearningItem,
  type LearningPhase,
} from "@/lib/knowledge/learning";

/**
 * Shown in place of the drop zone once a file is uploaded: "Billie is
 * learning" while the file is read, then a tick and "Billie is ready" (or
 * what went wrong and what to do). It asks how the reading is going every
 * couple of seconds until every file is done, then refreshes the list.
 */
export function LearningPanel({
  items,
  uploading,
  onChange,
  onAddMore,
}: {
  items: LearningItem[];
  uploading: { name: string; pct: number } | null;
  onChange: (update: (prev: LearningItem[]) => LearningItem[]) => void;
  onAddMore: () => void;
}) {
  const router = useRouter();
  const [slow, setSlow] = useState(false);
  const pending = items
    .filter(stillLearning)
    .map((i) => i.sourceId)
    .join(",");

  useEffect(() => {
    if (!pending) return;
    const ids = pending.split(",");
    const started = Date.now();
    let live = true;
    async function check() {
      if (document.visibilityState !== "visible") return;
      const r = await sourceStatusAction({ ids });
      if (!live || !r.ok || !r.data) return;
      const fresh = r.data;
      onChange((prev) => mergeStatuses(prev, fresh));
      if (fresh.length < ids.length || fresh.some((f) => !stillLearning(f))) router.refresh();
      if (Date.now() - started > LEARNING_SLOW_MS) setSlow(true);
    }
    const timer = setInterval(() => void check(), LEARNING_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pending, onChange, router]);

  const phase = learningPhase(items, !!uploading);
  const learning = items.filter(stillLearning).map((i) => i.name);
  const failed = items.filter((i) => i.status === "failed");

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="learning-panel"
      className="flex flex-col items-center gap-4 rounded-[12px] border border-border bg-background px-4 py-6 text-center sm:flex-row sm:items-center sm:gap-5 sm:px-6 sm:text-left"
    >
      <Visual phase={phase} />
      <div className="flex min-w-0 flex-1 flex-col items-center gap-2 sm:items-start">
        {phase === "learning" ? (
          <>
            <h3 className="text-[1.2rem]">
              Billie is learning
              <span className="learn-dots" aria-hidden="true">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </h3>
            <p className="break-words text-muted-foreground">
              {uploading
                ? `Uploading ${uploading.name}${uploading.pct ? ` (${uploading.pct}%)` : ""}.`
                : `Reading ${namesList(learning)}.`}{" "}
              This usually takes under a minute.
            </p>
            <div className="learn-bar" aria-hidden="true" />
            {slow ? (
              <p className="text-sm text-muted-foreground">
                This is taking longer than usual. You can leave this page: the file shows as Ready
                in the list below when Billie has finished.
              </p>
            ) : null}
          </>
        ) : phase === "ready" ? (
          <>
            <h3 className="text-[1.2rem]">Billie is ready</h3>
            <p className="break-words">{learnedSummary(items)} The bot can answer from it now.</p>
          </>
        ) : (
          <h3 className="break-words text-[1.2rem]">
            Billie couldn&apos;t read {failed.length === 1 ? failed[0].name : "these files"}
          </h3>
        )}
        {phase !== "learning" && failed.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {failed.map((f) => (
              <li key={f.sourceId} className="break-words text-bad">
                {phase === "ready" || failed.length > 1 ? `${f.name}: ` : ""}
                {f.error ?? "Billie couldn't read this file."}
              </li>
            ))}
          </ul>
        ) : null}
        {phase !== "learning" ? (
          <div className="mt-1">
            <Button variant={phase === "ready" ? "primary" : "default"} onClick={onAddMore}>
              <FileUp /> {phase === "ready" ? "Add another file" : "Choose another file"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Visual({ phase }: { phase: LearningPhase }) {
  if (phase === "learning")
    return (
      <div className="learn-visual" aria-hidden="true">
        <div className="learn-page">
          <i />
          <i />
          <i />
          <i />
          <i />
          <span className="learn-scan" />
        </div>
        <span className="brand-mark learn-think" />
      </div>
    );
  if (phase === "ready")
    return (
      <svg className="ready-tick size-[72px] shrink-0" viewBox="0 0 52 52" aria-hidden="true">
        <circle
          cx="26"
          cy="26"
          r="24"
          fill="var(--good-soft)"
          stroke="var(--good)"
          strokeWidth="3"
        />
        <path
          d="M15.5 27 L22.5 34 L37 19.5"
          fill="none"
          stroke="var(--good)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  return (
    <svg className="size-[72px] shrink-0" viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r="24" fill="var(--warn-soft)" stroke="var(--warn)" strokeWidth="3" />
      <path d="M26 14 V30" stroke="var(--warn)" strokeWidth="4" strokeLinecap="round" />
      <circle cx="26" cy="37.5" r="2.6" fill="var(--warn)" />
    </svg>
  );
}
