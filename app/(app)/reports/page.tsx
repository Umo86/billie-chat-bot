import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, Panel } from "@/components/ui/bits";
import { TabsNav } from "@/components/ui/tabs-nav";
import { requireActor } from "@/lib/auth/actor";
import { busiestHours, kpis, perBot, topQuestions, usageSince } from "@/lib/reports/queries";

export const metadata: Metadata = { title: "Reports" };

const PERIODS = [7, 30, 90] as const;
const fmt = new Intl.NumberFormat("en-GB");

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireActor("reports.view");
  const sp = await searchParams;
  const days = PERIODS.find((p) => String(p) === sp.days) ?? 30;
  const since = new Date(Date.now() - days * 86_400_000);
  const [k, top, hours, bots, usage] = await Promise.all([
    kpis(since),
    topQuestions(since, 10),
    busiestHours(since),
    perBot(since),
    usageSince(since),
  ]);
  const peak = Math.max(1, ...hours);
  const tiles = [
    { n: fmt.format(k.chats), label: "chats" },
    {
      n: k.answeredAlonePct === null ? "–" : `${k.answeredAlonePct}%`,
      label: "answered without the team",
    },
    { n: fmt.format(k.handedOver), label: "passed to the team" },
    { n: fmt.format(k.emailsDrafted), label: "email replies drafted" },
    { n: k.helpfulPct === null ? "–" : `${k.helpfulPct}%`, label: "of rated answers were helpful" },
    {
      n: fmt.format(k.openGaps),
      label: "questions waiting for an answer",
      href: "/knowledge?tab=gaps",
    },
  ];

  return (
    <>
      <PageHeader
        title="Reports"
        lede="What people ask, how much Billie answers on its own, and when it's busy. Test chats aren't counted."
      />
      <TabsNav
        label="Period"
        current={String(days)}
        tabs={PERIODS.map((p) => ({
          key: String(p),
          href: `/reports?days=${p}`,
          label: `Last ${p} days`,
        }))}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {tiles.map((t) => {
          const inner = (
            <>
              <span className="font-[family-name:var(--font-display)] text-[1.75rem] font-extrabold tabular-nums">
                {t.n}
              </span>
              <span className="text-sm text-muted-foreground">{t.label}</span>
            </>
          );
          return t.href ? (
            <Link
              key={t.label}
              href={t.href}
              className="flex flex-col rounded-[14px] border border-border bg-card px-4 py-3.5 hover:border-primary/50"
            >
              {inner}
            </Link>
          ) : (
            <div
              key={t.label}
              className="flex flex-col rounded-[14px] border border-border bg-card px-4 py-3.5"
            >
              {inner}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel className="flex flex-col gap-3">
          <h2 className="text-[1.05rem]">Busiest times (UK)</h2>
          <div
            className="flex h-36 items-end gap-[3px]"
            role="img"
            aria-label="Chats started by hour of the day"
          >
            {hours.map((n, h) => (
              <div key={h} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t-[3px] bg-primary/80"
                  style={{
                    height: `${Math.max(n ? 4 : 1, (n / peak) * 120)}px`,
                    opacity: n ? 1 : 0.25,
                  }}
                  title={`${String(h).padStart(2, "0")}:00 — ${n} chats`}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground" aria-hidden>
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>23:00</span>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">As a table</summary>
            <table className="mt-2 w-full text-left">
              <thead>
                <tr>
                  <th className="py-1 font-semibold">Hour</th>
                  <th className="py-1 font-semibold">Chats</th>
                </tr>
              </thead>
              <tbody>
                {hours.map((n, h) => (
                  <tr key={h}>
                    <td className="py-0.5">{String(h).padStart(2, "0")}:00</td>
                    <td className="py-0.5 tabular-nums">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </Panel>

        <Panel className="flex flex-col gap-3">
          <h2 className="text-[1.05rem]">Most asked</h2>
          {top.length ? (
            <ol className="flex flex-col gap-1.5">
              {top.map((q, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-[0.94rem]">
                  <span className="min-w-0 break-words">&ldquo;{q.question}&rdquo;</span>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    {q.times}×
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground">No chats in this period yet.</p>
          )}
        </Panel>
      </div>

      <Panel className="overflow-x-auto p-0 sm:p-0">
        <table className="w-full min-w-[560px] text-left text-[0.94rem]">
          <caption className="px-4 pt-4 text-left font-[family-name:var(--font-display)] text-[1.05rem] font-bold sm:px-5">
            By bot
          </caption>
          <thead className="text-sm text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 font-semibold sm:px-5">Bot</th>
              <th className="px-3 py-2 font-semibold">Chats</th>
              <th className="px-3 py-2 font-semibold">Passed to team</th>
              <th className="px-3 py-2 font-semibold">Unanswered</th>
              <th className="px-3 py-2 font-semibold">Last test</th>
            </tr>
          </thead>
          <tbody>
            {bots.map((b) => (
              <tr key={b.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5 sm:px-5">
                  <Link
                    href={`/bots/${b.id}`}
                    className="inline-flex items-center gap-2 font-semibold hover:underline"
                  >
                    <span
                      className="size-3 rounded-full"
                      style={{ background: b.color }}
                      aria-hidden
                    />
                    {b.name}
                  </Link>
                </td>
                <td className="px-3 py-2.5 tabular-nums">{fmt.format(b.chats)}</td>
                <td className="px-3 py-2.5 tabular-nums">
                  {fmt.format(b.handed)}
                  {b.chats ? (
                    <span className="text-muted-foreground">
                      {" "}
                      ({Math.round((b.handed / b.chats) * 100)}%)
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 tabular-nums">{b.open_gaps}</td>
                <td className="px-3 py-2.5 tabular-nums">
                  {b.last_test?.total ? `${b.last_test.passed}/${b.last_test.total}` : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <p className="text-sm text-muted-foreground">
        Claude use in this period: {fmt.format(usage.requests)} requests,{" "}
        {fmt.format(usage.input + usage.output)} tokens
        {usage.cached ? ` (${fmt.format(usage.cached)} served from cache)` : ""}.
      </p>
    </>
  );
}
