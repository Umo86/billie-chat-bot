"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Eye, FileText, Globe, MessageSquareText, RotateCw, Trash2, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState, Panel } from "@/components/ui/bits";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { useRunner } from "@/components/ui/use-runner";
import {
  deleteSourceAction,
  passagesAction,
  rereadAction,
  restoreSourceAction,
} from "@/app/actions/knowledge";
import type { SourceRow } from "@/lib/knowledge/queries";

const KIND_ICON = { file: FileText, text: Type, qa: MessageSquareText, web: Globe } as const;
const KIND_LABEL = {
  file: "File",
  text: "Pasted text",
  qa: "Typed answer",
  web: "Web page",
} as const;

function when(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

export function SourceList({ sources, canEdit }: { sources: SourceRow[]; canEdit: boolean }) {
  const [viewing, setViewing] = useState<SourceRow | null>(null);
  const busy = sources.some((s) => s.status === "queued" || s.status === "reading");

  if (!sources.length)
    return (
      <EmptyState title="Nothing in here yet">
        Add the exhibitor manual, a price list or the show&apos;s FAQ page above. Billie answers
        only from what&apos;s in the knowledge base, so the more complete it is, the fewer questions
        go to the team.
      </EmptyState>
    );

  return (
    <Panel className="p-0 sm:p-0">
      <AutoRefresh active={busy} />
      <ul className="divide-y divide-border" aria-label="Sources">
        {sources.map((s) => (
          <SourceItem key={s.id} source={s} canEdit={canEdit} onView={() => setViewing(s)} />
        ))}
      </ul>
      <Passages source={viewing} onClose={() => setViewing(null)} />
    </Panel>
  );
}

function SourceItem({
  source: s,
  canEdit,
  onView,
}: {
  source: SourceRow;
  canEdit: boolean;
  onView: () => void;
}) {
  const { pending, run } = useRunner();
  const Icon = KIND_ICON[s.kind];

  function remove() {
    run(() => deleteSourceAction({ id: s.id }), {
      done: () =>
        toast(`Removed "${s.title}". Bots stop using it straight away.`, {
          action: {
            label: "Undo",
            onClick: async () => {
              const r = await restoreSourceAction({ id: s.id });
              if (!r.ok) toast.error(r.error);
            },
          },
        }),
    });
  }

  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3.5 sm:px-5" data-testid="source-row">
      <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 basis-64">
        <p className="break-words font-semibold">{s.title}</p>
        <p className="mt-0.5 break-all text-sm text-muted-foreground">
          {KIND_LABEL[s.kind]}
          {s.kind === "web" && s.url ? ` · ${s.url}` : ""}
          {s.addedBy ? ` · added by ${s.addedBy}` : ""} · {when(s.createdAt)}
        </p>
        {s.status === "failed" && s.error ? (
          <p className="mt-1 text-sm text-bad">{s.error}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {s.status === "ready" ? (
          <Chip tone="good">
            Ready · {s.passageCount} {s.passageCount === 1 ? "passage" : "passages"}
          </Chip>
        ) : s.status === "failed" ? (
          <Chip tone="bad">Couldn&apos;t read</Chip>
        ) : (
          <Chip tone="info">Reading…</Chip>
        )}
        {s.kind === "web" && s.refreshWeekly ? <Chip>Checked weekly</Chip> : null}
        {s.status === "ready" ? (
          <Button size="sm" variant="ghost" onClick={onView}>
            <Eye /> View
          </Button>
        ) : null}
        {canEdit && (s.status === "failed" || s.kind === "web" || s.kind === "file") ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || s.status === "queued" || s.status === "reading"}
            onClick={() => run(() => rereadAction({ id: s.id }))}
          >
            <RotateCw /> {s.status === "failed" ? "Try again" : "Read again"}
          </Button>
        ) : null}
        {canEdit ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-bad"
            disabled={pending}
            onClick={remove}
            aria-label={`Remove ${s.title}`}
          >
            <Trash2 /> Remove
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function Passages({ source, onClose }: { source: SourceRow | null; onClose: () => void }) {
  return (
    <Dialog open={!!source} onOpenChange={(o) => !o && onClose()}>
      {source ? (
        <DialogContent
          title={source.title}
          description="This is the text Billie read, split into the passages it searches. If something is missing or garbled here, the bot can't answer it."
          className="w-[min(94vw,820px)]"
        >
          <PassageBody key={source.id} id={source.id} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function PassageBody({ id }: { id: string }) {
  const [rows, setRows] = useState<{ ordinal: number; label: string; text: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    passagesAction({ id })
      .then((r) => {
        if (!live) return;
        if (!r.ok) toast.error(r.error);
        setRows(r.ok ? (r.data ?? []) : []);
      })
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [id]);

  if (rows === null) return <p role="status">Loading…</p>;
  if (!rows.length) return <p>No passages.</p>;
  return (
    <ol className="flex flex-col gap-3">
      {rows.map((p) => (
        <li key={p.ordinal} className="rounded-[10px] bg-muted px-3 py-2.5">
          <p className="label-caps mb-1">{p.label || `Passage ${p.ordinal + 1}`}</p>
          <p className="whitespace-pre-wrap text-[0.92rem] leading-relaxed">{p.text}</p>
        </li>
      ))}
    </ol>
  );
}
