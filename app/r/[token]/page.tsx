import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Chip } from "@/components/ui/bits";
import { requestByToken } from "@/lib/requests/service";
import { REQUEST_STATUS_LABEL } from "@/lib/requests/rules";

/**
 * A request's own page, for the person who made it (the link in the chat
 * and in their emails). Anyone with the link can see it, so it shows only
 * what they sent and the team's reply: no email address or phone number.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your request", robots: { index: false } };

const TONE = { new: "warn", in_progress: "info", done: "good", declined: "neutral" } as const;

function when(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

export default async function RequestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await requestByToken(token);
  if (!r) notFound();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[680px] flex-col gap-4 px-4 py-8">
      <p className="text-sm text-muted-foreground">
        {r.showName || r.botName} · request {r.ref}
      </p>
      <h1 className="text-2xl">{r.typeName}</h1>
      <section
        aria-label="Where it's up to"
        className="flex flex-col gap-2 rounded-[14px] border border-border bg-card p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={TONE[r.status]}>{REQUEST_STATUS_LABEL[r.status]}</Chip>
          <span className="text-sm text-muted-foreground">Updated {when(r.updatedAt)}</span>
        </div>
        <p>{r.statusText}</p>
        {r.note ? (
          <div className="rounded-[10px] bg-muted px-3 py-2.5">
            <p className="label-caps mb-0.5">From the team</p>
            <p className="whitespace-pre-wrap break-words">{r.note}</p>
          </div>
        ) : null}
      </section>
      <section
        aria-label="What you sent"
        className="flex flex-col gap-2 rounded-[14px] border border-border bg-card p-4"
      >
        <h2 className="text-[1.05rem]">What you sent</h2>
        <p className="text-sm text-muted-foreground">
          {when(r.createdAt)}
          {r.company ? ` · ${r.company}` : ""}
          {r.stand ? ` · stand ${r.stand}` : ""}
        </p>
        <dl className="grid gap-2">
          {r.answers.map((a, i) => (
            <div key={i}>
              <dt className="text-sm font-semibold">{a.label}</dt>
              <dd className="whitespace-pre-wrap break-words">{a.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p className="text-sm text-muted-foreground">
        Keep this link to check on your request. To add something, reply in the chat or quote{" "}
        {r.ref} when you contact the team.
      </p>
    </main>
  );
}
