"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/bits";
import { Field, Select } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { saveModelsAction } from "@/app/actions/settings";

type Model = { id: string; name: string; blurb: string; prices: string };

/**
 * Settings → AI: which Claude model does Fast work and which Thorough work.
 * Each bot is set to Fast or Thorough on its Knowledge step.
 */
export function ModelsForm({
  models,
  initial,
}: {
  models: Model[];
  /** The models in use now (from Settings, the environment or the defaults). */
  initial: { fast: string; thorough: string };
}) {
  const router = useRouter();
  const known = (id: string) => models.some((m) => m.id === id);
  const [fast, setFast] = useState(known(initial.fast) ? initial.fast : "");
  const [thorough, setThorough] = useState(known(initial.thorough) ? initial.thorough : "");
  const save = useRunner();
  const changed = fast !== initial.fast || thorough !== initial.thorough;

  const options = (current: string) => (
    <>
      {!current ? (
        <option value="" disabled>
          Choose a model
        </option>
      ) : null}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}: {m.prices}
        </option>
      ))}
    </>
  );

  return (
    <Panel className="flex flex-col gap-3" data-testid="ai-models">
      <div>
        <h2 className="text-[1.05rem]">Models</h2>
        <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
          Each bot is set to Fast or Thorough on its Knowledge step. If the chosen model is busy,
          Billie uses the other one, so an answer still goes out. A change applies to the next
          question.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field
          id="model-fast"
          label="Fast"
          hint="Bots set to Fast (usually visitor bots), and sorting incoming emails."
        >
          <Select id="model-fast" value={fast} onChange={(e) => setFast(e.target.value)}>
            {options(fast)}
          </Select>
        </Field>
        <Field
          id="model-thorough"
          label="Thorough"
          hint="Bots set to Thorough (usually exhibitor bots), email drafts, knowledge checks, learning from sent emails and deadline reminders."
        >
          <Select
            id="model-thorough"
            value={thorough}
            onChange={(e) => setThorough(e.target.value)}
          >
            {options(thorough)}
          </Select>
        </Field>
      </div>
      <ul className="flex flex-col gap-1.5 text-sm" aria-label="The models">
        {models.map((m) => (
          <li key={m.id}>
            <strong>{m.name}</strong>: {m.blurb}{" "}
            <span className="text-muted-foreground">({m.prices}.)</span>
          </li>
        ))}
      </ul>
      <div>
        <Button
          variant="primary"
          disabled={save.pending || !fast || !thorough || !changed}
          onClick={() =>
            save.run(() => saveModelsAction({ fast, thorough }), { done: () => router.refresh() })
          }
        >
          Save models
        </Button>
      </div>
    </Panel>
  );
}
