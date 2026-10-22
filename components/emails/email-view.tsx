"use client";

import { useState } from "react";
import { Check, RefreshCw, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Textarea } from "@/components/ui/form";
import { CopyButton } from "@/components/ui/copy-button";
import { useRunner } from "@/components/ui/use-runner";
import {
  dismissEmailAction,
  markSentAction,
  redoDraftAction,
  reopenEmailAction,
  saveDraftAction,
} from "@/app/actions/emails";
import type { EmailTags, MessageSource } from "@/lib/types";
import { EMAIL_STATUS, type EmailStatus as Status } from "@/lib/emails/status";

export function EmailView({
  email,
}: {
  email: {
    id: string;
    source: "outlook" | "manual";
    fromName: string;
    fromEmail: string;
    subject: string;
    body: string;
    receivedAt: string;
    status: Status;
    tags: EmailTags | null;
    summary: string;
    needsYouReason: string | null;
    draft: string;
    draftSources: MessageSource[];
    outlookDraftId: string | null;
    error: string | null;
  };
}) {
  const [draft, setDraft] = useState(email.draft);
  const act = useRunner();
  const writing = email.status === "new" || email.status === "working";
  const done = email.status === "sent" || email.status === "dismissed";
  const changed = draft !== email.draft;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="break-words">{email.subject || "(no subject)"}</h2>
            <p className="mt-1 break-all text-sm text-muted-foreground">
              {email.fromName ? `${email.fromName} · ` : ""}
              {email.fromEmail || "unknown sender"} ·{" "}
              {new Intl.DateTimeFormat("en-GB", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "Europe/London",
              }).format(new Date(email.receivedAt))}
              {email.source === "outlook" ? " · Outlook" : " · Pasted"}
            </p>
          </div>
          <Chip tone={EMAIL_STATUS[email.status].tone}>{EMAIL_STATUS[email.status].label}</Chip>
        </div>
        {email.tags ? (
          <div className="flex flex-wrap gap-1.5">
            <Chip tone="accent">{email.tags.topic}</Chip>
            {email.tags.company ? <Chip>{email.tags.company}</Chip> : null}
            {email.tags.stand ? <Chip>Stand {email.tags.stand}</Chip> : null}
            {email.tags.urgency === "high" ? <Chip tone="bad">Urgent</Chip> : null}
          </div>
        ) : null}
        {email.summary ? <p className="font-semibold">{email.summary}</p> : null}
        <details className="rounded-[10px] bg-muted px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold">The email</summary>
          <p className="mt-2 whitespace-pre-wrap text-[0.92rem]">{email.body}</p>
        </details>
      </Panel>

      <Panel className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[1.05rem]">Reply</h2>
          {email.outlookDraftId ? (
            <span className="text-sm text-muted-foreground">
              Also saved as a draft in Outlook, in the same thread.
            </span>
          ) : null}
        </div>
        {writing ? (
          <Note>Billie is writing a draft reply…</Note>
        ) : email.status === "failed" ? (
          <Note tone="bad">
            {email.error ?? "Billie couldn't write a draft."} Try again, or reply yourself.
          </Note>
        ) : null}
        {email.needsYouReason && !done ? <Note tone="warn">{email.needsYouReason}</Note> : null}
        {!writing ? (
          <>
            <label htmlFor="draft" className="sr-only">
              Draft reply
            </label>
            <Textarea
              id="draft"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-64 font-[inherit]"
              placeholder="Write the reply here."
              disabled={done}
            />
            {email.draftSources.length ? (
              <p className="text-sm text-muted-foreground">
                Source:{" "}
                {email.draftSources
                  .map((s) => `${s.title}${s.label ? ` (${s.label})` : ""}`)
                  .join("; ")}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Check the facts, then copy it into your reply. Billie never sends emails itself.
            </p>
          </>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {!writing && !done ? (
            <>
              <CopyButton text={draft} label="Copy reply" />
              {changed ? (
                <Button
                  size="sm"
                  disabled={act.pending}
                  onClick={() => act.run(() => saveDraftAction({ id: email.id, draft }))}
                >
                  Save changes
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="primary"
                disabled={act.pending}
                onClick={() => act.run(() => markSentAction({ id: email.id, draft }))}
              >
                <Check /> Mark as sent
              </Button>
              <Button
                size="sm"
                disabled={act.pending}
                onClick={() => act.run(() => redoDraftAction({ id: email.id }))}
              >
                <RefreshCw /> Write it again
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={act.pending}
                onClick={() => act.run(() => dismissEmailAction({ id: email.id }))}
              >
                <X /> Dismiss
              </Button>
            </>
          ) : null}
          {done ? (
            <Button
              size="sm"
              disabled={act.pending}
              onClick={() => act.run(() => reopenEmailAction({ id: email.id }))}
            >
              <RotateCcw /> Reopen
            </Button>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
