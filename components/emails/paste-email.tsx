"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardPaste, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { pasteEmailAction } from "@/app/actions/emails";

const EXAMPLE = {
  fromName: "Sam Carter (example)",
  fromEmail: "sam.carter@example.com",
  subject: "Build-up times and badges for stand C42",
  body: "Hi team,\n\nWe're exhibiting on stand C42. What time can our contractors start building on the first build-up day, and how many exhibitor badges do we get?\n\nThanks,\nSam",
};

export function PasteEmail({
  bots,
  defaultBotId,
}: {
  bots: { id: string; name: string }[];
  defaultBotId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ fromName: "", fromEmail: "", subject: "", body: "" });
  const [botId, setBotId] = useState(defaultBotId ?? bots[0]?.id ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, run } = useRunner();
  const set = (k: keyof typeof v, val: string) => setV((x) => ({ ...x, [k]: val }));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary">
          <ClipboardPaste /> Paste an email
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Paste an email"
        description="Billie drafts a reply from the knowledge base. You check it and send it from your mailbox."
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setErrors({});
            run(() => pasteEmailAction({ ...v, botId: botId || null }), {
              failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
              done: (d) => {
                setOpen(false);
                setV({ fromName: "", fromEmail: "", subject: "", body: "" });
                if (d?.id) router.push(`/emails?e=${d.id}`);
              },
            });
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="em-name" label="From (name)">
              <Input
                id="em-name"
                value={v.fromName}
                onChange={(e) => set("fromName", e.target.value)}
                maxLength={120}
              />
            </Field>
            <Field id="em-email" label="From (email)" error={errors.fromEmail}>
              <Input
                id="em-email"
                type="email"
                value={v.fromEmail}
                onChange={(e) => set("fromEmail", e.target.value)}
                maxLength={200}
              />
            </Field>
          </div>
          <Field id="em-subject" label="Subject">
            <Input
              id="em-subject"
              value={v.subject}
              onChange={(e) => set("subject", e.target.value)}
              maxLength={300}
            />
          </Field>
          <Field id="em-body" label="Email" error={errors.body}>
            <Textarea
              id="em-body"
              value={v.body}
              onChange={(e) => set("body", e.target.value)}
              className="min-h-44"
              required
            />
          </Field>
          {bots.length > 1 ? (
            <Field id="em-bot" label="Answer from" hint="Which bot's knowledge to use.">
              <Select id="em-bot" value={botId} onChange={(e) => setBotId(e.target.value)}>
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" onClick={() => setV(EXAMPLE)}>
              <Wand2 /> Use an example
            </Button>
            <div className="flex gap-2">
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary" disabled={pending || !v.body.trim()}>
                Write a draft
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
