"use client";

import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Panel } from "@/components/ui/bits";
import { Field, Textarea } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { dismissUnhelpfulAction, fixUnhelpfulAction } from "@/app/actions/knowledge";

type Row = {
  id: string;
  botName: string;
  question: string;
  answer: string;
  count: number;
  lastAt: string;
};

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Answers people marked unhelpful: fix one (a typed answer) or dismiss it. */
export function UnhelpfulList({ rows, canEdit }: { rows: Row[]; canEdit: boolean }) {
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="unhelpful-heading">
      <div>
        <h2 id="unhelpful-heading" className="text-[1.05rem]">
          Answers people found unhelpful
        </h2>
        <p className="text-muted-foreground">
          Someone gave these a thumbs down. Fix the answer and it goes into that bot&apos;s
          knowledge as a typed answer, used from then on.
        </p>
      </div>
      <ul className="flex flex-col gap-3" aria-label="Answers people found unhelpful">
        {rows.map((r) => (
          <Item key={r.id} row={r} canEdit={canEdit} />
        ))}
      </ul>
    </section>
  );
}

function Item({ row, canEdit }: { row: Row; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState(row.answer);
  const { pending, run } = useRunner();

  return (
    <li id={`unhelpful-${row.id}`} className="scroll-mt-4">
      <Panel className="flex flex-col gap-3" data-testid="unhelpful-row">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <p className="break-words font-semibold">&ldquo;{row.question}&rdquo;</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {row.botName} · last marked {ago(row.lastAt)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="warn">
              {row.count === 1 ? "Unhelpful once" : `Unhelpful ${row.count} times`}
            </Chip>
            {canEdit && !open ? (
              <>
                <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
                  <Pencil /> Fix the answer
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => dismissUnhelpfulAction({ id: row.id }))}
                >
                  <X /> Dismiss
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {!open ? (
          <div className="rounded-[10px] bg-muted px-3 py-2 text-sm">
            <span className="font-semibold text-muted-foreground">Billie said: </span>
            <span className="whitespace-pre-wrap break-words">{row.answer}</span>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3 border-t border-border pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => fixUnhelpfulAction({ id: row.id, answer }), {
                done: () => setOpen(false),
              });
            }}
          >
            <Field
              id={`unhelpful-${row.id}-answer`}
              label="The right answer"
              hint="It starts as what Billie said. Change it to what it should say."
            >
              <Textarea
                id={`unhelpful-${row.id}-answer`}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                maxLength={4000}
                rows={5}
                required
                autoFocus
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="primary"
                disabled={pending || !answer.trim() || answer.trim() === row.answer.trim()}
              >
                <Check /> Save answer
              </Button>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </form>
        )}
      </Panel>
    </li>
  );
}
