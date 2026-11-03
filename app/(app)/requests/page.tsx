import type { Metadata } from "next";
import Link from "next/link";
import { Chip, EmptyState, PageHeader } from "@/components/ui/bits";
import { TabsNav } from "@/components/ui/tabs-nav";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { RequestView } from "@/components/requests/request-view";
import { requireActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import {
  requestCounts,
  requestDetail,
  requestHandlers,
  requestList,
  type RequestTab,
} from "@/lib/requests/service";
import { REQUEST_STATUS_LABEL } from "@/lib/requests/rules";
import { timeAgo } from "@/lib/time";
import { emailConfigured } from "@/lib/config";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Requests" };

const TABS: { key: RequestTab; label: string }[] = [
  { key: "new", label: "New" },
  { key: "in_progress", label: "In progress" },
  { key: "finished", label: "Finished" },
];

const TONE = { new: "warn", in_progress: "info", done: "good", declined: "neutral" } as const;

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor("inbox.view");
  const sp = await searchParams;
  const picked = sp.r && /^[0-9a-f-]{36}$/i.test(sp.r) ? sp.r : null;
  const pickedDetail = picked ? await requestDetail(picked) : null;
  // Opening a request from Teams shows the tab it's in.
  const tab: RequestTab = TABS.some((t) => t.key === sp.tab)
    ? (sp.tab as RequestTab)
    : pickedDetail
      ? pickedDetail.status === "new"
        ? "new"
        : pickedDetail.status === "in_progress"
          ? "in_progress"
          : "finished"
      : "new";
  const [rows, counts, handlers] = await Promise.all([
    requestList(tab),
    requestCounts(),
    requestHandlers(),
  ]);
  const detail = pickedDetail ?? (rows[0] ? await requestDetail(rows[0].id) : null);

  return (
    <>
      <AutoRefresh active every={15000} />
      <PageHeader
        title="Requests"
        lede="Requests people made through a bot's chat, such as extra build-up hours. Each one has a reference and a page the person can follow, and once email is set up they're emailed when it changes."
      />
      <TabsNav
        label="Request sections"
        current={tab}
        tabs={TABS.map((t) => ({
          key: t.key,
          href: `/requests?tab=${t.key}`,
          label: t.key !== "finished" && counts[t.key] ? `${t.label} (${counts[t.key]})` : t.label,
        }))}
      />
      {!rows.length && !detail ? (
        <EmptyState title={tab === "new" ? "No new requests" : "No requests here"}>
          Requests arrive when someone fills in a request form in a bot&apos;s chat. Choose which
          requests each bot takes on its Rules step.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <ul
            aria-label="Requests"
            className={cn("flex flex-col gap-1.5", picked && "hidden lg:flex")}
          >
            {!rows.length ? (
              <li className="px-1 text-sm text-muted-foreground">
                No {TABS.find((t) => t.key === tab)?.label.toLowerCase()} requests.
              </li>
            ) : null}
            {rows.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/requests?tab=${tab}&r=${r.id}`}
                  aria-current={r.id === detail?.id ? "page" : undefined}
                  data-testid="request-row"
                  className={cn(
                    "flex flex-col gap-1 rounded-[12px] border border-border bg-card px-3.5 py-3 hover:border-primary/50",
                    r.id === detail?.id && "border-primary bg-accent",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      {r.ref} · {r.typeName}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {timeAgo(r.createdAt)}
                    </span>
                  </span>
                  <span className="line-clamp-1 text-sm">{r.from}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Chip className="h-5 text-[0.7rem]" tone={TONE[r.status]}>
                      {REQUEST_STATUS_LABEL[r.status]}
                    </Chip>
                    {r.test ? <Chip className="h-5 text-[0.7rem]">TEST</Chip> : null}
                    <span className="text-xs text-muted-foreground">
                      {r.botName}
                      {r.assignedName ? ` · ${r.assignedName}` : " · nobody yet"}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {detail ? (
            <RequestView
              // A new version (someone saved) starts the form again from it.
              key={`${detail.id}:${detail.updatedAt}`}
              request={{ ...detail, emailOn: emailConfigured() }}
              handlers={handlers}
              canHandle={can(actor, "inbox.reply")}
              backHref={`/requests?tab=${tab}`}
            />
          ) : null}
        </div>
      )}
    </>
  );
}
