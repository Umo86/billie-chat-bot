"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Download, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Note, Panel } from "@/components/ui/bits";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { deletePersonAction, findPersonAction } from "@/app/actions/settings";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Found = {
  chats: number;
  emails: number;
  requests: number;
  exhibitors: number;
  reminders: number;
};

/** "2 chats, 1 email and 1 request" (and "1 exhibitor list row" when there are any) */
function holding(f: Found): string {
  const parts = [
    count(f.chats, "chat", "chats"),
    count(f.emails, "email", "emails"),
    count(f.requests, "request", "requests"),
    ...(f.exhibitors ? [count(f.exhibitors, "exhibitor list row", "exhibitor list rows")] : []),
    ...(f.reminders ? [count(f.reminders, "deadline reminder", "deadline reminders")] : []),
  ];
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Requests from a person about their data: a copy, or deleting it (UK GDPR). */
export function Privacy({ retentionMonths }: { retentionMonths: number }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<(Found & { q: string }) | null>(null);
  const [confirm, setConfirm] = useState(false);
  const find = useRunner();
  const del = useRunner();

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-3">
        <div>
          <h2 className="text-[1.05rem]">Someone asks for their data, or for it to be deleted</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Search by the email address or phone number they gave. You&apos;ll find chats where they
            left details or signed in, WhatsApp chats from their number, emails from their address,
            requests they sent from a chat, their rows on exhibitor lists and deadline reminders
            sent to them. Everything else is deleted automatically after {retentionMonths} months.
          </p>
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            find.run(() => findPersonAction({ q }), {
              done: (d) =>
                d &&
                setFound({
                  q,
                  chats: d.chats,
                  emails: d.emails,
                  requests: d.requests,
                  exhibitors: d.exhibitors,
                  reminders: d.reminders,
                }),
            });
          }}
        >
          <Field id="person" label="Email or phone number" className="min-w-0 flex-1 basis-64">
            <Input id="person" value={q} onChange={(e) => setQ(e.target.value)} required />
          </Field>
          <Button type="submit" disabled={find.pending || q.trim().length < 3}>
            <Search /> Find
          </Button>
        </form>
        {found ? (
          found.chats + found.emails + found.requests + found.exhibitors + found.reminders === 0 ? (
            <Note>Nothing found for {found.q}.</Note>
          ) : (
            <Note tone="warn">
              <p>
                Found {holding(found)} for {found.q}.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <a href={`/api/privacy/export?q=${encodeURIComponent(found.q)}`}>
                    <Download /> Download a copy
                  </a>
                </Button>
                <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
                  <Trash2 /> Delete all of it
                </Button>
              </div>
            </Note>
          )
        ) : null}
      </Panel>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        {found ? (
          <DialogContent title={`Delete everything for ${found.q}?`}>
            <p>
              {holding(found)} will be deleted for good. This can&apos;t be undone. The audit log
              records that you did it, not what was deleted.
            </p>
            {found.exhibitors ? (
              <p>
                Take them off the exhibitor spreadsheet too, or they&apos;ll be back the next time
                the list is uploaded.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button
                variant="dangerSolid"
                disabled={del.pending}
                onClick={() =>
                  del.run(() => deletePersonAction({ q: found.q }), {
                    done: (d) => {
                      setConfirm(false);
                      setFound(null);
                      setQ("");
                      if (d) toast.success(`Deleted ${holding(d)}.`);
                    },
                  })
                }
              >
                Delete for good
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
