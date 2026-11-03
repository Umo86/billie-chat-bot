"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/bits";
import { Segmented } from "@/components/ui/segmented";
import { useRunner } from "@/components/ui/use-runner";
import { updateBotAction } from "@/app/actions/bots";

type Quality = "fast" | "thorough";

/** The end of the Knowledge step: how carefully the bot reads, then on to Rules. */
export function KnowledgeStep({
  botId,
  quality: initialQuality,
  canEdit,
  next,
}: {
  botId: string;
  quality: Quality;
  canEdit: boolean;
  /** The step after Knowledge (Exhibitors on exhibitor bots, otherwise Rules). */
  next: string;
}) {
  const router = useRouter();
  const [quality, setQuality] = useState<Quality>(initialQuality);
  const { pending, run } = useRunner();

  function save() {
    run(() => updateBotAction({ id: botId, quality }), {
      done: () => router.push(`/bots/${botId}?step=${next}`),
    });
  }

  return (
    <>
      <Panel className="flex flex-col gap-1.5">
        <h2 className="text-[1.05rem]">Answer quality</h2>
        {canEdit ? (
          <Segmented<Quality>
            label="Answer quality"
            value={quality}
            onChange={setQuality}
            options={[
              { value: "fast", label: "Fast" },
              { value: "thorough", label: "Thorough" },
            ]}
          />
        ) : (
          <p className="font-semibold">{quality === "fast" ? "Fast" : "Thorough"}</p>
        )}
        <p className="text-sm text-muted-foreground">
          {quality === "fast"
            ? "Quick, low-cost answers. Good for visitor questions."
            : "A stronger model that reads more carefully. Best for exhibitor rules, deadlines and prices."}
        </p>
      </Panel>
      {canEdit ? (
        <div>
          <Button variant="primary" onClick={save} disabled={pending}>
            Save and continue
          </Button>
        </div>
      ) : null}
    </>
  );
}
