"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Replace } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { Note } from "@/components/ui/bits";
import { useRunner } from "@/components/ui/use-runner";
import { previewReplaceAction, replaceAction } from "@/app/actions/knowledge";
import type { ReplacePreview } from "@/lib/knowledge/edit";

const KIND = { text: "Pasted text", qa: "Typed answer", file: "File", web: "Web page" } as const;
const times = (n: number) => `${n} ${n === 1 ? "time" : "times"}`;

/**
 * Find and replace across a bot's knowledge, e.g. a new email address for
 * exhibitor questions. Preview first; pasted text and typed answers change,
 * files and web pages are listed to change at the source.
 */
export function ReplaceDialog({ kbId, kbName }: { kbId: string; kbName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [preview, setPreview] = useState<ReplacePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const looking = useRunner();
  const applying = useRunner();

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setFind("");
      setReplace("");
      setPreview(null);
      setError(null);
    }
  }

  function look(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    looking.run(() => previewReplaceAction({ kbId, find, replace }), {
      done: (d) => setPreview(d ?? null),
      failed: (r) => !r.ok && setError(r.fieldErrors?.find ?? null),
    });
  }

  function apply() {
    applying.run(() => replaceAction({ kbId, find, replace }), {
      done: (d) => {
        toast.success(
          d?.sources
            ? `Replaced in ${d.sources} ${d.sources === 1 ? "source" : "sources"}. Billie is reading ${d.sources === 1 ? "it" : "them"} again.`
            : "Nothing to replace any more.",
        );
        reset(false);
        router.refresh();
      },
    });
  }

  const total = preview
    ? preview.editable.reduce((n, s) => n + s.count, 0) +
      preview.elsewhere.reduce((n, s) => n + s.count, 0)
    : 0;

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Replace /> Find and replace
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Find and replace"
        description={`Change a piece of text everywhere in ${kbName}, such as an email address, a phone number or a name. You see every change before it's made.`}
        className="w-[min(94vw,760px)]"
      >
        <form onSubmit={look} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field id="replace-find" label="Find" error={error}>
            <Input
              id="replace-find"
              value={find}
              onChange={(e) => {
                setFind(e.target.value);
                setPreview(null);
              }}
              maxLength={200}
              required
              aria-invalid={!!error}
            />
          </Field>
          <Field id="replace-with" label="Replace with">
            <Input
              id="replace-with"
              value={replace}
              onChange={(e) => {
                setReplace(e.target.value);
                setPreview(null);
              }}
              maxLength={500}
            />
          </Field>
          <Button type="submit" disabled={looking.pending || find.trim().length < 2}>
            Preview
          </Button>
        </form>
        <p className="-mt-1 text-sm text-muted-foreground">
          Capitals don&apos;t matter when finding. Leave &quot;Replace with&quot; empty to remove
          the text.
        </p>

        {preview ? (
          <div className="flex flex-col gap-3" data-testid="replace-preview">
            <p className="font-semibold">
              {total
                ? `Found ${times(total)} in ${preview.editable.length + preview.elsewhere.length} ${preview.editable.length + preview.elsewhere.length === 1 ? "source" : "sources"}.`
                : "Not found in this bot's knowledge."}
            </p>
            {preview.editable.length ? (
              <ul className="flex flex-col gap-2" aria-label="Sources that will change">
                {preview.editable.map((s) => (
                  <li key={s.id} className="rounded-[10px] bg-muted px-3 py-2.5 text-sm">
                    <p className="font-semibold">
                      {s.title}{" "}
                      <span className="font-normal text-muted-foreground">
                        · {KIND[s.kind]} · {times(s.count)}
                      </span>
                    </p>
                    {s.samples.map((x, i) => (
                      <div key={i} className="mt-1.5 grid gap-0.5">
                        <p className="break-words text-muted-foreground line-through decoration-bad/60">
                          {x.before}
                        </p>
                        <p className="break-words">{x.after}</p>
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.elsewhere.length ? (
              <Note tone="warn">
                <p className="font-semibold">
                  Also in files and web pages, which Billie can&apos;t change:
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {preview.elsewhere.map((s) => (
                    <li key={s.id}>
                      {s.title} ({KIND[s.kind]}, {times(s.count)})
                    </li>
                  ))}
                </ul>
                <p className="mt-1">
                  Change the original file and upload it again, or update the web page and press
                  &quot;Read again&quot;.
                </p>
              </Note>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            onClick={apply}
            disabled={!preview?.editable.length || applying.pending}
          >
            {preview?.editable.length
              ? `Replace in ${preview.editable.length} ${preview.editable.length === 1 ? "source" : "sources"}`
              : "Replace"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
