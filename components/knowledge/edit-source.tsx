"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { editSourceAction, sourceTextAction } from "@/app/actions/knowledge";
import type { EditableSource } from "@/lib/knowledge/edit";

/** Edit a pasted text or a typed answer; Billie reads it again when it's saved. */
export function EditSourceDialog({
  source,
  onClose,
}: {
  source: { id: string; title: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!source} onOpenChange={(o) => !o && onClose()}>
      {source ? (
        <DialogContent
          title={`Edit "${source.title}"`}
          description="Bots keep using the current version until Billie has read the new one, usually within a minute."
          className="w-[min(94vw,820px)]"
        >
          <EditForm key={source.id} id={source.id} onDone={onClose} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function EditForm({ id, onDone }: { id: string; onDone: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState<EditableSource | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, run } = useRunner();
  // Loaded once per source: the list refreshing behind the dialog mustn't reset what's typed.
  const close = useRef(onDone);
  useEffect(() => {
    close.current = onDone;
  });

  useEffect(() => {
    let live = true;
    sourceTextAction({ id })
      .then((r) => {
        if (!live) return;
        if (r.ok && r.data) setForm(r.data);
        else {
          toast.error(r.ok ? "Couldn't open it." : r.error);
          close.current();
        }
      })
      .catch(() => live && close.current());
    return () => {
      live = false;
    };
  }, [id]);

  if (!form) return <p role="status">Loading…</p>;

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setErrors({});
    run(() => editSourceAction({ id, ...form }), {
      done: (d) => {
        toast.success(d?.changed ? "Saved. Billie is reading it again." : "Nothing changed.");
        onDone();
        router.refresh();
      },
      failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
    });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      {form.kind === "text" ? (
        <>
          <Field id="edit-title" label="Title" error={errors.title}>
            <Input
              id="edit-title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              maxLength={200}
            />
          </Field>
          <Field id="edit-body" label="Text" error={errors.body}>
            <Textarea
              id="edit-body"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              className="min-h-72"
              required
              aria-invalid={!!errors.body}
            />
          </Field>
        </>
      ) : (
        <>
          <Field id="edit-question" label="Question" error={errors.question}>
            <Input
              id="edit-question"
              value={form.question}
              onChange={(e) => setForm({ ...form, question: e.target.value })}
              maxLength={300}
              required
              aria-invalid={!!errors.question}
            />
          </Field>
          <Field id="edit-answer" label="Answer" error={errors.answer}>
            <Textarea
              id="edit-answer"
              value={form.answer}
              onChange={(e) => setForm({ ...form, answer: e.target.value })}
              maxLength={4000}
              className="min-h-36"
              required
              aria-invalid={!!errors.answer}
            />
          </Field>
        </>
      )}
      <div className="flex justify-end gap-2">
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button type="submit" variant="primary" disabled={pending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
