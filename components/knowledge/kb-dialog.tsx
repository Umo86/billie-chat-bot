"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import {
  createKbAction,
  deleteKbAction,
  renameKbAction,
  restoreKbAction,
} from "@/app/actions/knowledge";

type Kb = { id: string; name: string; description: string };

export function NewKbButton({ variant = "primary" }: { variant?: "primary" | "default" }) {
  return (
    <KbDialog
      trigger={
        <Button variant={variant}>
          <Plus /> New knowledge base
        </Button>
      }
    />
  );
}

export function KbDialog({ kb, trigger }: { kb?: Kb; trigger: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(kb?.name ?? "");
  const [description, setDescription] = useState(kb?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = useRunner();

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (kb) {
      run(() => renameKbAction({ id: kb.id, name, description }), {
        done: () => setOpen(false),
        failed: (r) => !r.ok && setError(r.fieldErrors?.name ?? null),
      });
    } else {
      run(() => createKbAction({ name, description }), {
        done: (d) => {
          setOpen(false);
          setName("");
          setDescription("");
          if (d?.id) router.push(`/knowledge?kb=${d.id}`);
        },
        failed: (r) => !r.ok && setError(r.fieldErrors?.name ?? null),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        title={kb ? "Rename knowledge base" : "New knowledge base"}
        description={
          kb
            ? undefined
            : "A knowledge base is a set of documents and answers. Bots can share one, or each have their own."
        }
      >
        <form onSubmit={save} className="flex flex-col gap-4">
          <Field id="kb-name" label="Name" hint="For example: Exhibitor knowledge" error={error}>
            <Input
              id="kb-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              autoFocus
              aria-invalid={!!error}
            />
          </Field>
          <Field id="kb-desc" label="Description (optional)" hint="What's in it, in a few words.">
            <Input
              id="kb-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={pending}>
              {kb ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function KbActions({ kb, usedBy }: { kb: Kb; usedBy: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { pending, run } = useRunner();

  function remove() {
    run(() => deleteKbAction({ id: kb.id }), {
      done: () => {
        setOpen(false);
        router.push("/knowledge");
        toast(`Deleted "${kb.name}".`, {
          action: {
            label: "Undo",
            onClick: async () => {
              const r = await restoreKbAction({ id: kb.id });
              if (r.ok) router.push(`/knowledge?kb=${kb.id}`);
              else toast.error(r.error);
            },
          },
        });
      },
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      <KbDialog
        kb={kb}
        trigger={
          <Button size="sm">
            <Pencil /> Rename
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="danger">
            <Trash2 /> Delete
          </Button>
        </DialogTrigger>
        <DialogContent title={`Delete "${kb.name}"?`}>
          <p>
            {usedBy
              ? `${usedBy === 1 ? "A bot uses" : `${usedBy} bots use`} this knowledge base. They will stop answering from it straight away.`
              : "No bot uses this knowledge base."}{" "}
            It stays in the bin for 30 days, so you can undo this.
          </p>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button>Keep it</Button>
            </DialogClose>
            <Button variant="dangerSolid" onClick={remove} disabled={pending}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
