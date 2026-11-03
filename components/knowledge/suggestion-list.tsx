"use client";

import { useState } from "react";
import { Check, Inbox, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Panel } from "@/components/ui/bits";
import { Field, Input, Textarea } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { dismissSuggestionsAction, saveSuggestionAction } from "@/app/actions/knowledge";
import type { SuggestionRow } from "@/lib/emails/history";

/**
 * Questions people often asked the event mailbox, with the answer the team
 * gave, found in its past emails. Check each one, then save it as a typed
 * answer, or dismiss it.
 */
export function SuggestionList({ rows, canEdit }: { rows: SuggestionRow[]; canEdit: boolean }) {
  const all = useRunner();
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="suggestions-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="suggestions-heading" className="text-[1.05rem]">
            Common questions from past emails
          </h2>
          <p className="mt-1 max-w-[68ch] text-muted-foreground">
            Billie read the event mailbox&apos;s past emails and the team&apos;s replies. These came
            up most. Check the answer is still right for this show, then save it.
          </p>
        </div>
        {canEdit ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={all.pending}
            onClick={() => all.run(() => dismissSuggestionsAction({ ids: rows.map((r) => r.id) }))}
          >
            <X /> Dismiss all
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-3" aria-label="Common questions from past emails">
        {rows.map((r) => (
          <Item key={r.id} row={r} canEdit={canEdit} />
        ))}
      </ul>
    </section>
  );
}

function Item({ row, canEdit }: { row: SuggestionRow; canEdit: boolean }) {
  const [question, setQuestion] = useState(row.question);
  const [answer, setAnswer] = useState(row.answer);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useRunner();
  const dismiss = useRunner();
  const id = `suggestion-${row.id}`;
  return (
    <li>
      <Panel className="flex flex-col gap-3" data-testid="suggestion-row">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="flex min-w-0 items-center gap-2 font-semibold">
            <Inbox className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="break-words">{row.question}</span>
          </p>
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            {row.botName}
            <Chip tone="accent">
              {row.count === 1 ? "Asked in 1 email" : `Asked in ${row.count} emails`}
            </Chip>
          </span>
        </div>
        {canEdit ? (
          <form
            className="flex flex-col gap-3 border-t border-border pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              setErrors({});
              save.run(() => saveSuggestionAction({ id: row.id, question, answer }), {
                failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
              });
            }}
          >
            <Field id={`${id}-q`} label="Question" error={errors.question}>
              <Input
                id={`${id}-q`}
                value={question}
                maxLength={300}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </Field>
            <Field id={`${id}-a`} label="Answer" error={errors.answer}>
              <Textarea
                id={`${id}-a`}
                value={answer}
                maxLength={4000}
                onChange={(e) => setAnswer(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={save.pending}>
                <Check /> Save as a typed answer
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={dismiss.pending}
                onClick={() => dismiss.run(() => dismissSuggestionsAction({ ids: [row.id] }))}
              >
                <X /> Dismiss
              </Button>
            </div>
          </form>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm">{row.answer}</p>
        )}
      </Panel>
    </li>
  );
}
