"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { copyBotAction } from "@/app/actions/bots";

/** Copy a bot for the next show or edition, then check its dates. */
export function CopyBot({ bot }: { bot: { id: string; name: string; showName: string } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(nextName(bot.name));
  const [showName, setShowName] = useState(nextYear(bot.showName) ?? bot.showName);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, run } = useRunner();

  function copy(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    run(() => copyBotAction({ id: bot.id, name, showName }), {
      done: (d) => {
        setOpen(false);
        if (d?.id) router.push(`/bots/${d.id}?step=knowledge&copied=1`);
      },
      failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Copy /> Copy for another show
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Copy "${bot.name}"`}
        description="For the next edition, or the same show in another city. The copy gets the look, personality, rules, requests, test questions, people and all the knowledge. It starts as a draft, with no website, mailbox or Teams channel, and lists every date to check."
      >
        <form onSubmit={copy} className="flex flex-col gap-4">
          <Field id="copy-name" label="Name of the copy" error={errors.name}>
            <Input
              id="copy-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
              autoFocus
              aria-invalid={!!errors.name}
            />
          </Field>
          <Field
            id="copy-show"
            label="Show name"
            hint="For example: Ideal Home Show Christmas 2027"
          >
            <Input
              id="copy-show"
              value={showName}
              onChange={(e) => setShowName(e.target.value)}
              maxLength={80}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={pending}>
              Make the copy
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "UKCW 2026" becomes "UKCW 2027"; with no year, null. */
function nextYear(name: string): string | null {
  const years = [...name.matchAll(/\b(20\d{2})\b/g)];
  if (!years.length) return null;
  const last = years[years.length - 1];
  const i = last.index ?? 0;
  return `${name.slice(0, i)}${Number(last[1]) + 1}${name.slice(i + 4)}`;
}

/** The copy's name: next year's, or the same name with "(copy)". */
function nextName(name: string): string {
  return nextYear(name) ?? `${name} (copy)`.slice(0, 60);
}
