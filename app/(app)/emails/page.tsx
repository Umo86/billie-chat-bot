import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";
import { Chip, EmptyState, Note, PageHeader } from "@/components/ui/bits";
import { TabsNav } from "@/components/ui/tabs-nav";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { PasteEmail } from "@/components/emails/paste-email";
import { EmailView } from "@/components/emails/email-view";
import { EMAIL_STATUS } from "@/lib/emails/status";
import { requireActor } from "@/lib/auth/actor";
import { emailDetail, emailList, type EmailTab } from "@/lib/emails/service";
import { botCards } from "@/lib/bots/queries";
import { getSettings } from "@/lib/settings";
import { outlookConfigured } from "@/lib/config";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Emails" };

export default async function EmailsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireActor("emails.view");
  const sp = await searchParams;
  const tab: EmailTab = sp.tab === "done" ? "done" : "check";
  const [rows, bots, settings] = await Promise.all([emailList(tab), botCards(), getSettings()]);
  const picked = sp.e && /^[0-9a-f-]{36}$/i.test(sp.e) ? sp.e : null;
  const selected = picked ?? rows[0]?.id ?? null;
  const email = selected ? await emailDetail(selected) : null;
  const writing = rows.some((r) => r.status === "new" || r.status === "working");
  const exhibitorBots = bots.filter((b) => b.audience === "exhibitors");
  const choices = (exhibitorBots.length ? exhibitorBots : bots).map((b) => ({
    id: b.id,
    name: b.name,
  }));

  return (
    <>
      <AutoRefresh active={writing || email?.status === "new" || email?.status === "working"} />
      <PageHeader
        title="Emails"
        lede="Exhibitor emails with a draft reply from the knowledge base. You check every draft before it goes."
        actions={
          <PasteEmail bots={choices} defaultBotId={settings.emailBotId ?? choices[0]?.id ?? null} />
        }
      />
      {!outlookConfigured() ? (
        <Note>
          The exhibitor mailbox isn&apos;t connected yet, so paste emails here. Once an admin
          connects it in Settings, new emails arrive by themselves with the draft saved in Outlook.
        </Note>
      ) : null}
      <TabsNav
        label="Email sections"
        current={tab}
        tabs={[
          { key: "check", href: "/emails", label: "To check" },
          { key: "done", href: "/emails?tab=done", label: "Done" },
        ]}
      />
      {!rows.length && !email ? (
        <EmptyState title={tab === "check" ? "No emails to check" : "Nothing done yet"}>
          {tab === "check"
            ? "Paste an exhibitor's email and Billie drafts the reply from the exhibitor knowledge."
            : "Emails you mark as sent or dismiss end up here."}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <ul
            aria-label="Emails"
            className={cn("flex flex-col gap-1.5", picked && "hidden lg:flex")}
          >
            {rows.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/emails?${tab === "done" ? "tab=done&" : ""}e=${r.id}`}
                  aria-current={r.id === selected ? "page" : undefined}
                  data-testid="email-row"
                  className={cn(
                    "flex flex-col gap-1 rounded-[12px] border border-border bg-card px-3.5 py-3 hover:border-primary/50",
                    r.id === selected && "border-primary bg-accent",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      {r.fromName || r.fromEmail || "Unknown sender"}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {timeAgo(r.receivedAt)}
                    </span>
                  </span>
                  <span className="line-clamp-1 text-sm">{r.subject || "(no subject)"}</span>
                  {r.summary ? (
                    <span className="line-clamp-1 text-sm text-muted-foreground">{r.summary}</span>
                  ) : null}
                  <span className="flex flex-wrap gap-1.5">
                    <Chip className="h-5 text-[0.7rem]" tone={EMAIL_STATUS[r.status].tone}>
                      {EMAIL_STATUS[r.status].label}
                    </Chip>
                    {r.tags?.urgency === "high" ? (
                      <Chip className="h-5 text-[0.7rem]" tone="bad">
                        Urgent
                      </Chip>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {email ? (
            <div className="flex min-w-0 flex-col gap-2">
              {picked ? (
                <Link
                  href="/emails"
                  className="inline-flex items-center gap-1 text-sm font-semibold text-primary lg:hidden"
                >
                  <ArrowLeft className="size-4" aria-hidden /> All emails
                </Link>
              ) : null}
              <EmailView
                key={`${email.id}:${email.status}:${email.updatedAt.toISOString()}`}
                email={{
                  id: email.id,
                  source: email.source,
                  fromName: email.fromName,
                  fromEmail: email.fromEmail,
                  subject: email.subject,
                  body: email.body,
                  receivedAt: email.receivedAt.toISOString(),
                  status: email.status,
                  tags: email.tags,
                  summary: email.summary,
                  needsYouReason: email.needsYouReason,
                  draft: email.draft,
                  draftSources: email.draftSources,
                  outlookDraftId: email.outlookDraftId,
                  error: email.error,
                }}
              />
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
