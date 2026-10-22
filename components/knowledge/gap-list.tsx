"use client";

import { useState } from "react";
import { Check, MessageSquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState, Panel } from "@/components/ui/bits";
import { Field, Select, Textarea } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { answerGapAction, dismissGapAction } from "@/app/actions/knowledge";
import type { GapRow } from "@/lib/knowledge/queries";

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function GapList({
  gaps,
  kbs,
  canEdit,
}: {
  gaps: GapRow[];
  kbs: { id: string; name: string }[];
  canEdit: boolean;
}) {
  if (!gaps.length)
    return (
      <EmptyState title="Nothing unanswered">
        When a bot can&apos;t find an answer in its knowledge, the question shows up here. Add the
        answer once and the bot uses it from then on.
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        Questions your bots couldn&apos;t answer from their knowledge, most asked first. Each answer
        you add here becomes a typed answer the bot uses straight away.
      </p>
      <ul className="flex flex-col gap-3" aria-label="Unanswered questions">
        {gaps.map((g) => (
          <GapItem key={g.id} gap={g} kbs={kbs} canEdit={canEdit} />
        ))}
      </ul>
    </div>
  );
}

function GapItem({
  gap,
  kbs,
  canEdit,
}: {
  gap: GapRow;
  kbs: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const own = kbs.filter((k) => gap.kbIds.includes(k.id));
  const choices = own.length ? own : kbs;
  const [open, setOpen] = useState(false);
  const [kbId, setKbId] = useState(choices[0]?.id ?? "");
  const [answer, setAnswer] = useState("");
  const { pending, run } = useRunner();

  return (
    <li>
      <Panel className="flex flex-col gap-3" data-testid="gap-row">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <p className="break-words font-semibold">&ldquo;{gap.question}&rdquo;</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {gap.botName} · last asked {ago(gap.lastAskedAt)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={gap.askCount > 2 ? "warn" : "neutral"}>
              Asked {gap.askCount} {gap.askCount === 1 ? "time" : "times"}
            </Chip>
            {canEdit && !open ? (
              <>
                <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
                  <MessageSquarePlus /> Add answer
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => dismissGapAction({ gapId: gap.id }))}
                >
                  <X /> Dismiss
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {open ? (
          <form
            className="flex flex-col gap-3 border-t border-border pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => answerGapAction({ gapId: gap.id, kbId, answer }), {
                done: () => setOpen(false),
              });
            }}
          >
            <Field id={`gap-${gap.id}-answer`} label="Answer">
              <Textarea
                id={`gap-${gap.id}-answer`}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                maxLength={4000}
                required
                autoFocus
              />
            </Field>
            {choices.length > 1 ? (
              <Field id={`gap-${gap.id}-kb`} label="Save it in">
                <Select
                  id={`gap-${gap.id}-kb`}
                  value={kbId}
                  onChange={(e) => setKbId(e.target.value)}
                >
                  {choices.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={pending || !answer.trim() || !kbId}>
                <Check /> Save answer
              </Button>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </form>
        ) : null}
      </Panel>
    </li>
  );
}
