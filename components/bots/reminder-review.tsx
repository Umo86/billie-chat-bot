"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, RotateCcw, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Field, Input, Textarea } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import {
  discardRemindersAction,
  retryFailedRemindersAction,
  saveReminderTextAction,
  sendRemindersAction,
  startRemindersAction,
} from "@/app/actions/exhibitors";
import { fillIn, unknownPlaceholders } from "@/lib/exhibitors/deadline-rules";

type Status = "drafting" | "ready" | "sending" | "sent" | "discarded" | "failed";
type Recipient = {
  id: string;
  company: string;
  stand: string;
  name: string;
  to: string[];
  status: "pending" | "left_out" | "queued" | "sent" | "failed";
  note: string;
  since: "done" | "gone" | null;
};

const SHOW = 200;
const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

const STATUS: Record<
  Recipient["status"],
  { tone: "neutral" | "good" | "bad" | "info"; label: string }
> = {
  pending: { tone: "neutral", label: "To send" },
  queued: { tone: "info", label: "Sending" },
  sent: { tone: "good", label: "Sent" },
  failed: { tone: "bad", label: "Not sent" },
  left_out: { tone: "neutral", label: "Left out" },
};

/**
 * Checking a batch of deadline reminders: the email (with what Billie fills
 * in for each exhibitor), a preview, and who it goes to. Nothing is sent
 * until someone presses Send and confirms.
 */
export function ReminderReview({
  botId,
  batch,
  recipients,
  replyTo,
  emailReady,
  canSend,
}: {
  botId: string;
  batch: {
    id: string;
    deadlineId: string;
    status: Status;
    subject: string;
    body: string;
    note: string;
    sources: { title: string; label: string }[];
    sent: string | null;
  };
  recipients: Recipient[];
  replyTo: string | null;
  emailReady: boolean;
  canSend: boolean;
}) {
  const router = useRouter();
  const [subject, setSubject] = useState(batch.subject);
  const [body, setBody] = useState(batch.body);
  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(recipients.filter((r) => r.status === "pending" && !r.since).map((r) => r.id)),
  );
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const run = useRunner();

  const open = batch.status === "ready";
  const sendable = recipients.filter((r) => r.status === "pending" && !r.since);
  const count = sendable.filter((r) => ticked.has(r.id)).length;
  const sample = sendable.find((r) => ticked.has(r.id)) ?? recipients[0];
  const unknown = useMemo(() => unknownPlaceholders(`${subject}\n${body}`), [subject, body]);
  const sent = recipients.filter((r) => r.status === "sent").length;
  const failed = recipients.filter((r) => r.status === "failed").length;
  const queued = recipients.filter((r) => r.status === "queued").length;
  const shown = all ? recipients : recipients.slice(0, SHOW);

  function draftAgain() {
    run.run(() => startRemindersAction({ deadlineId: batch.deadlineId }), {
      done: (r) => r && router.push(`/bots/${botId}/reminders/${r.batchId}`),
    });
  }

  function send() {
    run.run(
      () =>
        sendRemindersAction({
          batchId: batch.id,
          subject,
          body,
          leaveOut: recipients
            .filter((r) => r.status === "pending" && !ticked.has(r.id))
            .map((r) => r.id),
        }),
      {
        done: (d) => {
          setConfirm(false);
          if (d)
            toast.success(
              `Sending ${plural(d.queued, "reminder", "reminders")}.${d.leftOut ? ` ${d.leftOut} left out.` : ""}`,
            );
          router.refresh();
        },
        failed: () => setConfirm(false),
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {batch.status === "drafting" ? (
        <Panel className="flex items-center gap-3" role="status">
          <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
          <p>
            Billie is writing the reminder for{" "}
            {plural(recipients.length, "exhibitor", "exhibitors")}. This page updates by itself.
          </p>
        </Panel>
      ) : null}
      {batch.status === "failed" ? (
        <Note tone="bad">
          <p>{batch.note || "Billie couldn't write the reminder."}</p>
          {canSend ? (
            <Button size="sm" className="mt-2" onClick={draftAgain} disabled={run.pending}>
              <RotateCcw /> Draft them again
            </Button>
          ) : null}
        </Note>
      ) : null}
      {batch.status === "discarded" ? <Note>Discarded. Nothing was sent.</Note> : null}
      {batch.status === "sending" || batch.status === "sent" ? (
        <Note tone={failed ? "warn" : "good"}>
          <p data-testid="send-progress">
            {batch.status === "sending"
              ? `Sending: ${sent} of ${plural(sent + queued + failed, "reminder", "reminders")} sent so far. This page updates by itself.`
              : `${plural(sent, "reminder", "reminders")} sent${batch.sent ? ` ${batch.sent}` : ""}.`}
            {failed ? ` ${failed} couldn't be sent: see why below.` : ""}
          </p>
          {failed && batch.status === "sent" && canSend && emailReady ? (
            <Button
              size="sm"
              className="mt-2"
              disabled={run.pending}
              onClick={() =>
                run.run(() => retryFailedRemindersAction({ batchId: batch.id }), {
                  done: () => router.refresh(),
                })
              }
            >
              <RotateCcw /> Try those again
            </Button>
          ) : null}
        </Note>
      ) : null}

      {batch.status !== "drafting" && batch.status !== "failed" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel className="flex flex-col gap-3">
            <h2 className="text-[1.05rem]">The email</h2>
            {open && batch.note ? (
              <Note tone="warn">
                The knowledge doesn&apos;t say: {batch.note} Add it to the email, or to the
                bot&apos;s knowledge.
              </Note>
            ) : null}
            {open && canSend ? (
              <>
                <Field id="rm-subject" label="Subject">
                  <Input
                    id="rm-subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    maxLength={200}
                  />
                </Field>
                <Field
                  id="rm-body"
                  label="Email"
                  hint="Billie fills in {first_name}, {company} and {stand} (as “stand B12”) for each exhibitor."
                  error={
                    unknown.length
                      ? `Billie can't fill in ${unknown.join(", ")}. Use {first_name}, {company} or {stand}.`
                      : null
                  }
                >
                  <Textarea
                    id="rm-body"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={14}
                    aria-invalid={unknown.length > 0}
                  />
                </Field>
              </>
            ) : (
              <div className="flex flex-col gap-1.5">
                <p className="font-semibold">{subject}</p>
                <p className="text-sm whitespace-pre-wrap">{body}</p>
              </div>
            )}
            {batch.sources.length ? (
              <p className="text-sm text-muted-foreground">
                From:{" "}
                {batch.sources.map((s) => [s.title, s.label].filter(Boolean).join(", ")).join("; ")}
              </p>
            ) : null}
          </Panel>

          <Panel className="flex flex-col gap-2" data-testid="reminder-preview">
            <h2 className="text-[1.05rem]">What {sample?.company || "an exhibitor"} gets</h2>
            {sample ? (
              <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-muted/50 p-3 text-sm">
                <p>
                  <span className="text-muted-foreground">To:</span> {sample.to.join(", ")}
                </p>
                {replyTo ? (
                  <p>
                    <span className="text-muted-foreground">Replies go to:</span> {replyTo}, the
                    event mailbox
                  </p>
                ) : null}
                <p>
                  <span className="text-muted-foreground">Subject:</span>{" "}
                  <strong>{fillIn(subject, sample)}</strong>
                </p>
                <p className="whitespace-pre-wrap break-words">{fillIn(body, sample)}</p>
              </div>
            ) : null}
          </Panel>
        </div>
      ) : null}

      {batch.status !== "failed" ? (
        <Panel className="flex flex-col gap-3" data-testid="reminder-recipients">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[1.05rem]">
              {open
                ? `Who it goes to: ${count} of ${plural(recipients.length, "exhibitor", "exhibitors")}`
                : `Exhibitors (${recipients.length.toLocaleString("en-GB")})`}
            </h2>
            {open && canSend ? (
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setTicked(new Set(sendable.map((r) => r.id)))}
                >
                  Tick all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setTicked(new Set())}>
                  Untick all
                </Button>
              </div>
            ) : null}
          </div>
          {open && recipients.some((r) => r.since) ? (
            <p className="text-sm text-muted-foreground">
              Some have done it, or left the list, since Billie drafted these. They won&apos;t get
              one.
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-[10px] border border-border">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead className="bg-muted text-[0.8rem] text-muted-foreground">
                <tr>
                  {open && canSend ? (
                    <th className="w-10 px-3 py-2">
                      <span className="sr-only">Send</span>
                    </th>
                  ) : null}
                  <th className="px-3 py-2 font-semibold">Company</th>
                  <th className="px-3 py-2 font-semibold">Stand</th>
                  <th className="px-3 py-2 font-semibold">Contact</th>
                  <th className="px-3 py-2 font-semibold">Email</th>
                  <th className="px-3 py-2 font-semibold">
                    <span className={open ? "sr-only" : ""}>Status</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const label = `${r.company || r.name || r.to[0]}${r.stand ? `, stand ${r.stand}` : ""}`;
                  return (
                    <tr key={r.id} className="border-t border-border align-top">
                      {open && canSend ? (
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--color-primary)]"
                            aria-label={`Send to ${label}`}
                            checked={ticked.has(r.id) && !r.since}
                            disabled={Boolean(r.since)}
                            onChange={() =>
                              setTicked((t) => {
                                const n = new Set(t);
                                if (n.has(r.id)) n.delete(r.id);
                                else n.add(r.id);
                                return n;
                              })
                            }
                          />
                        </td>
                      ) : null}
                      <td className="px-3 py-2">{r.company || "–"}</td>
                      <td className="px-3 py-2">{r.stand || "–"}</td>
                      <td className="px-3 py-2">{r.name || "–"}</td>
                      <td className="px-3 py-2 break-all">{r.to.join(", ")}</td>
                      <td className="px-3 py-2">
                        {r.since === "done" ? (
                          <Chip tone="good">Done since</Chip>
                        ) : r.since === "gone" ? (
                          <Chip>Not on the list</Chip>
                        ) : open ? null : (
                          <span className="flex flex-col gap-0.5">
                            <Chip tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Chip>
                            {r.note && r.status !== "sent" ? (
                              <span className="text-[0.8rem] text-muted-foreground">{r.note}</span>
                            ) : null}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {recipients.length > SHOW && !all ? (
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setAll(true)}>
              Show all {recipients.length.toLocaleString("en-GB")}
            </Button>
          ) : null}
        </Panel>
      ) : null}

      {open && canSend ? (
        <div className="flex flex-col gap-2">
          {!emailReady ? (
            <Note tone="warn">
              Email sending isn&apos;t set up yet (an admin adds RESEND_API_KEY and EMAIL_FROM), so
              these can&apos;t be sent. You can still change the email and save it.
            </Note>
          ) : null}
          {confirm ? (
            <Note tone="warn">
              <p>
                Send {plural(count, "email", "emails")} now? Each exhibitor gets their own copy.
                This can&apos;t be undone.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={send} disabled={run.pending}>
                  <Send /> Send them
                </Button>
                <Button size="sm" onClick={() => setConfirm(false)}>
                  Cancel
                </Button>
              </div>
            </Note>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!emailReady || !count || unknown.length > 0 || run.pending || confirm}
              onClick={() => setConfirm(true)}
            >
              <Send /> Send {plural(count, "reminder", "reminders")}
            </Button>
            <Button
              disabled={run.pending || unknown.length > 0}
              onClick={() =>
                run.run(() => saveReminderTextAction({ batchId: batch.id, subject, body }), {
                  done: () => router.refresh(),
                })
              }
            >
              Save changes
            </Button>
            <Button
              variant="danger"
              disabled={run.pending}
              onClick={() =>
                run.run(() => discardRemindersAction({ batchId: batch.id }), {
                  done: () => router.push(`/bots/${botId}?step=exhibitors`),
                })
              }
            >
              <Trash2 /> Discard
            </Button>
          </div>
        </div>
      ) : open ? (
        <Note>Only editors and admins can send reminders.</Note>
      ) : null}
      {batch.status === "discarded" || batch.status === "sent" ? (
        <div>
          <Button asChild>
            <Link href={`/bots/${botId}?step=exhibitors`}>Back to Exhibitors</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
