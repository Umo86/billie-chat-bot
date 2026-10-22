"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Note, Panel } from "@/components/ui/bits";
import { Segmented } from "@/components/ui/segmented";
import { useRunner } from "@/components/ui/use-runner";
import { setBotKnowledgeAction, updateBotAction } from "@/app/actions/bots";
import type { KbSummary } from "@/lib/knowledge/queries";

type Tone = "friendly" | "formal" | "brief";
type Quality = "fast" | "thorough";

export function KnowledgeStep({
  botId,
  kbs,
  chosen,
  tone: initialTone,
  quality: initialQuality,
  canEdit,
}: {
  botId: string;
  kbs: KbSummary[];
  chosen: string[];
  tone: Tone;
  quality: Quality;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>(chosen);
  const [tone, setTone] = useState<Tone>(initialTone);
  const [quality, setQuality] = useState<Quality>(initialQuality);
  const { pending, run } = useRunner();

  if (!kbs.length)
    return (
      <EmptyState
        title="Add some knowledge first"
        action={
          <Button asChild variant="primary">
            <Link href="/knowledge">
              <BookOpen /> Go to Knowledge
            </Link>
          </Button>
        }
      >
        The bot answers only from knowledge bases you give it. Create one and add the exhibitor
        manual or the show&apos;s FAQ, then come back here.
      </EmptyState>
    );

  function save() {
    run(
      async () => {
        const a = await setBotKnowledgeAction({ id: botId, kbIds: picked });
        if (!a.ok) return a;
        return updateBotAction({ id: botId, tone, quality });
      },
      { done: () => router.push(`/bots/${botId}?step=rules`) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-3">
        <h2 className="text-[1.05rem]">Which knowledge should it answer from?</h2>
        <ul className="flex flex-col gap-2">
          {kbs.map((k) => {
            const on = picked.includes(k.id);
            return (
              <li key={k.id}>
                <label className="flex cursor-pointer items-start gap-3 rounded-[12px] border border-border px-3.5 py-3 has-[:checked]:border-primary has-[:checked]:bg-accent">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-[var(--color-primary)]"
                    checked={on}
                    disabled={!canEdit}
                    onChange={() =>
                      setPicked((p) => (on ? p.filter((x) => x !== k.id) : [...p, k.id]))
                    }
                  />
                  <span className="min-w-0">
                    <span className="block font-semibold">{k.name}</span>
                    <span className="block text-sm text-muted-foreground">
                      {k.sources} {k.sources === 1 ? "source" : "sources"} · {k.passages} passages
                      {k.description ? ` · ${k.description}` : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {!picked.length ? (
          <Note tone="warn">With no knowledge, the bot will pass every question to the team.</Note>
        ) : null}
      </Panel>

      <Panel className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[1.05rem]">How should it sound?</h2>
          <Segmented<Tone>
            label="Tone"
            value={tone}
            onChange={setTone}
            options={[
              { value: "friendly", label: "Friendly" },
              { value: "formal", label: "Formal" },
              { value: "brief", label: "Brief" },
            ]}
          />
          <p className="text-sm text-muted-foreground">
            {tone === "friendly"
              ? "Warm and plain, like a helpful colleague."
              : tone === "formal"
                ? "Polite and precise, for contracts, rules and deadlines."
                : "Short answers, straight to the point."}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[1.05rem]">Answer quality</h2>
          <Segmented<Quality>
            label="Answer quality"
            value={quality}
            onChange={setQuality}
            options={[
              { value: "fast", label: "Fast" },
              { value: "thorough", label: "Thorough" },
            ]}
          />
          <p className="text-sm text-muted-foreground">
            {quality === "fast"
              ? "Quick, low-cost answers. Good for visitor questions."
              : "A stronger model that reads more carefully. Best for exhibitor rules, deadlines and prices."}
          </p>
        </div>
      </Panel>

      {canEdit ? (
        <div>
          <Button variant="primary" onClick={save} disabled={pending}>
            Save and continue
          </Button>
        </div>
      ) : null}
    </div>
  );
}
