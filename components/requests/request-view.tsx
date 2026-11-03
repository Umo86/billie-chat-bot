"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Panel } from "@/components/ui/bits";
import { Field, Select, Textarea } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { updateRequestAction } from "@/app/actions/requests";
import { REQUEST_STATUS_LABEL } from "@/lib/requests/rules";
import { FIELD_LABEL } from "@/lib/bots/defaults";
import type { RequestDetail } from "@/lib/requests/service";
import type { ContactField, RequestStatus } from "@/lib/types";

const TONE = { new: "warn", in_progress: "info", done: "good", declined: "neutral" } as const;
const CONTACT_ORDER: ContactField[] = ["name", "company", "stand", "email", "phone"];

function when(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

/** One request: what they asked for, who they are, and handling it (status, owner, message). */
export function RequestView({
  request: r,
  handlers,
  canHandle,
  backHref,
}: {
  request: RequestDetail & { emailOn?: boolean };
  handlers: { id: string; name: string }[];
  canHandle: boolean;
  backHref: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<RequestStatus>(r.status);
  const [assignedTo, setAssignedTo] = useState(r.assignedTo ?? "");
  const [note, setNote] = useState(r.note);
  const { pending, run } = useRunner();
  const dirty = status !== r.status || assignedTo !== (r.assignedTo ?? "") || note !== r.note;

  function save(e: React.FormEvent) {
    e.preventDefault();
    // Only what this person changed, and only over the version they're looking at.
    run(
      () =>
        updateRequestAction({
          id: r.id,
          base: r.updatedAt,
          ...(status !== r.status ? { status } : {}),
          ...(note !== r.note ? { note } : {}),
          ...(assignedTo !== (r.assignedTo ?? "") ? { assignedTo: assignedTo || null } : {}),
        }),
      {
        done: () => {
          // A request that changes status moves tab: follow it there.
          if (status === r.status) return router.refresh();
          const tab = status === "new" || status === "in_progress" ? status : "finished";
          router.push(`/requests?tab=${tab}&r=${r.id}`);
        },
        failed: () => router.refresh(),
      },
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="request-view">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary lg:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden /> All requests
      </Link>
      <Panel className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words">
              {r.ref} · {r.typeName}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {r.botName}
              {r.showName ? ` · ${r.showName}` : ""} · sent {when(r.createdAt)}
            </p>
          </div>
          <div className="flex gap-1.5">
            {r.test ? <Chip>TEST</Chip> : null}
            <Chip tone={TONE[r.status]}>{REQUEST_STATUS_LABEL[r.status]}</Chip>
          </div>
        </div>

        <section aria-label="What they asked for" className="flex flex-col gap-2">
          {r.answers.length ? (
            <dl className="grid gap-2.5">
              {r.answers.map((a, i) => (
                <div key={i} className="rounded-[10px] bg-muted px-3 py-2.5">
                  <dt className="label-caps mb-0.5">{a.label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-[0.95rem]">{a.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-muted-foreground">They didn&apos;t add any details.</p>
          )}
        </section>

        <section aria-label="Who it's from">
          <h3 className="mb-1.5 text-[0.95rem]">From</h3>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.93rem]">
            {CONTACT_ORDER.filter((f) => r.contact[f]).map((f) => (
              <div key={f} className="contents">
                <dt className="text-muted-foreground">{FIELD_LABEL[f]}</dt>
                <dd className="break-all">{r.contact[f]}</dd>
              </div>
            ))}
          </dl>
        </section>

        <div className="flex flex-wrap gap-2">
          {r.conversationId ? (
            <Button asChild size="sm">
              <Link href={`/inbox?tab=billie&c=${r.conversationId}`}>
                <MessageCircle /> Open the chat
              </Link>
            </Button>
          ) : null}
          <Button asChild size="sm" variant="ghost">
            <a href={r.trackUrl} target="_blank" rel="noreferrer">
              <ExternalLink /> What they see
            </a>
          </Button>
        </div>
      </Panel>

      {canHandle ? (
        <Panel>
          <form onSubmit={save} className="flex flex-col gap-4" aria-label="Handle this request">
            <h3 className="text-[1.05rem]">Handle it</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="request-status" label="Status">
                <Select
                  id="request-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as RequestStatus)}
                >
                  {(["new", "in_progress", "done", "declined"] as const).map((s) => (
                    <option key={s} value={s}>
                      {REQUEST_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="request-owner" label="Handled by">
                <Select
                  id="request-owner"
                  value={assignedTo}
                  onChange={(e) => setAssignedTo(e.target.value)}
                >
                  <option value="">Nobody yet</option>
                  {handlers.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field
              id="request-note"
              label="Message to them (optional)"
              hint={
                r.emailOn
                  ? "Shown on their request's page, and emailed to them with the status when you save."
                  : "Shown on their request's page. Email isn't set up yet, so it isn't emailed: if it's urgent, email or call them yourself."
              }
            >
              <Textarea
                id="request-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                placeholder="e.g. Approved: you can build until 22:00 on Wednesday 25 November."
              />
            </Field>
            <div>
              <Button type="submit" variant="primary" disabled={pending || !dirty}>
                Save
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}

      {r.history.length ? (
        <Panel>
          <h3 className="mb-2 text-[0.95rem]">History</h3>
          <ol className="flex flex-col gap-1.5 text-sm">
            {r.history.map((h, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground">{when(h.at)}</span>
                <span className="font-semibold">{h.who}</span>
                <span>{h.what}</span>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}
    </div>
  );
}
