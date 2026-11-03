"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Panel, type Tone } from "@/components/ui/bits";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { useRunner } from "@/components/ui/use-runner";
import { checkKnowledgeAction } from "@/app/actions/knowledge";
import type { CheckView } from "@/lib/knowledge/check";
import type { CheckIssue } from "@/lib/types";
import { EditSourceDialog } from "./edit-source";

const KIND: Record<CheckIssue["kind"], { label: string; tone: Tone }> = {
  contradiction: { label: "Contradiction", tone: "bad" },
  date_passed: { label: "Date passed", tone: "warn" },
  contact: { label: "Contact details", tone: "warn" },
  unclear: { label: "Unclear", tone: "neutral" },
};

const SOURCE_KIND = { file: "file", text: "pasted text", qa: "typed answer", web: "web page" };

function when(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

/**
 * The knowledge check: Claude reads the whole knowledge base and lists
 * contradictions, dates that have passed and contact details that don't
 * match. Pasted text and typed answers can be fixed straight from the list.
 */
export function CheckPanel({
  kbId,
  check,
  canEdit,
}: {
  kbId: string;
  check: CheckView | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { pending, run } = useRunner();
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const busy = check?.status === "queued" || check?.status === "running";
  const n = check?.issues.length ?? 0;

  function start() {
    run(() => checkKnowledgeAction({ kbId }), { done: () => router.refresh() });
  }

  return (
    <Panel className="flex flex-col gap-3" data-testid="knowledge-check">
      <AutoRefresh active={busy} every={4000} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="text-[1.05rem]">Knowledge check</h2>
          {busy ? (
            <p className="mt-1 text-sm text-muted-foreground" role="status">
              Billie is reading the whole knowledge base. This takes about a minute.
            </p>
          ) : check?.status === "failed" ? (
            <p className="mt-1 text-sm text-bad">
              The last check didn&apos;t finish. {check.error}
            </p>
          ) : check?.status === "done" && check.finishedAt ? (
            <p className="mt-1 text-sm text-muted-foreground" role="status">
              Checked {when(check.finishedAt)}:{" "}
              <strong className="text-foreground">
                {n ? `${n} ${n === 1 ? "thing" : "things"} to look at` : "no problems found"}
              </strong>
              .
              {check.checkedSources < check.totalSources
                ? ` It read ${check.checkedSources} of ${check.totalSources} sources; the rest didn't fit in one check.`
                : ""}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              Billie reads the whole knowledge base and lists contradictions, dates that have passed
              and contact details that don&apos;t match, so a bot never gives two answers to one
              question.
            </p>
          )}
        </div>
        {canEdit ? (
          <Button size="sm" onClick={start} disabled={pending || busy}>
            <ShieldCheck /> {busy ? "Checking…" : check ? "Check again" : "Check now"}
          </Button>
        ) : null}
      </div>

      {check?.status === "done" && n ? (
        <ol className="flex flex-col gap-2.5" aria-label="What the check found">
          {check.issues.map((issue, i) => (
            <li key={i} className="flex flex-col gap-1.5 rounded-[12px] border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={KIND[issue.kind].tone}>{KIND[issue.kind].label}</Chip>
                <p className="font-semibold">{issue.title}</p>
              </div>
              <p className="text-[0.92rem]">{issue.detail}</p>
              {issue.quotes.map((q, j) => (
                <blockquote
                  key={j}
                  className="border-l-2 border-border pl-2.5 text-sm text-muted-foreground"
                >
                  {q}
                </blockquote>
              ))}
              {issue.sources.length ? (
                <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  <span>In:</span>
                  {issue.sources.map((s) =>
                    canEdit && s.id && (s.kind === "text" || s.kind === "qa") ? (
                      <Button
                        key={s.title}
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing({ id: s.id!, title: s.title })}
                        aria-label={`Edit ${s.title}`}
                      >
                        <Pencil /> {s.title}
                      </Button>
                    ) : (
                      <span key={s.title} className="rounded-md bg-muted px-2 py-0.5">
                        {s.title}
                        {s.kind ? ` (${SOURCE_KIND[s.kind]})` : ""}
                      </span>
                    ),
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <EditSourceDialog source={editing} onClose={() => setEditing(null)} />
    </Panel>
  );
}
