"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { useRunner } from "@/components/ui/use-runner";
import { deleteKbAction, restoreKbAction } from "@/app/actions/knowledge";

/**
 * Deletes an old shared knowledge base that no bot answers from any more.
 * A bot's own knowledge goes with the bot.
 */
export function DeleteOldKb({ kb }: { kb: { id: string; name: string } }) {
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="danger">
          <Trash2 /> Delete
        </Button>
      </DialogTrigger>
      <DialogContent title={`Delete "${kb.name}"?`}>
        <p>No bot answers from it. It stays in the bin for 30 days, so you can undo this.</p>
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
  );
}
