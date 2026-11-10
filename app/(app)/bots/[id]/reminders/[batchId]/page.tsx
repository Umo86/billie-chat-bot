import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Note, PageHeader } from "@/components/ui/bits";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { ReminderReview } from "@/components/bots/reminder-review";
import { requireActor } from "@/lib/auth/actor";
import { mayOnBot } from "@/lib/auth/bots";
import { batchDetail, dueLabel } from "@/lib/exhibitors/reminders";
import { daysLeft, daysUntil } from "@/lib/exhibitors/deadline-rules";
import { formatDateTime, londonDate } from "@/lib/time";

export const metadata: Metadata = { title: "Reminders" };
// Sending starts straight after the person presses Send: a round takes up to 40 seconds.
export const maxDuration = 300;

const UUID = /^[0-9a-f-]{36}$/i;

export default async function RemindersPage({
  params,
}: {
  params: Promise<{ id: string; batchId: string }>;
}) {
  const actor = await requireActor("bots.view");
  const { id, batchId } = await params;
  if (!UUID.test(id) || !UUID.test(batchId)) notFound();
  if (!(await mayOnBot(actor, "bots.view", id)))
    return (
      <>
        <PageHeader title="Reminders" />
        <Note tone="warn">
          You don&apos;t work on this bot. An admin can add you on its People step.
        </Note>
      </>
    );
  const detail = await batchDetail(batchId);
  if (!detail || detail.batch.botId !== id) notFound();
  const { batch, deadline } = detail;
  const canSend = await mayOnBot(actor, "reminders.send", id);

  return (
    <>
      <Link
        href={`/bots/${id}?step=exhibitors`}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
      >
        <ArrowLeft className="size-4" aria-hidden /> {detail.botName}: Exhibitors
      </Link>
      <PageHeader
        title={`Reminders: ${deadline.name}`}
        lede={`Due ${dueLabel(deadline.dueOn)} (${daysLeft(daysUntil(deadline.dueOn, londonDate()))}). ${
          batch.round > 1
            ? `Round ${batch.round}: the email sent last time, again, made ${formatDateTime(batch.createdAt)}.`
            : `Drafted ${formatDateTime(batch.createdAt)}.`
        }`}
      />
      <AutoRefresh active={batch.status === "drafting" || batch.status === "sending"} />
      <ReminderReview
        key={`${batch.id}:${batch.status}`}
        botId={id}
        batch={{
          id: batch.id,
          deadlineId: batch.deadlineId,
          status: batch.status,
          subject: batch.subject,
          body: batch.body,
          note: batch.note,
          sources: batch.sources,
          sent: batch.sentAt
            ? `${formatDateTime(batch.sentAt)}${
                batch.sentByName
                  ? ` by ${batch.sentByName}`
                  : batch.round > 1
                    ? " by Billie, automatically"
                    : ""
              }`
            : null,
          round: batch.round,
        }}
        repeatEvery={detail.plan.repeatDays}
        recipients={detail.recipients}
        replyTo={detail.replyTo}
        emailReady={detail.emailReady}
        canSend={canSend}
      />
    </>
  );
}
