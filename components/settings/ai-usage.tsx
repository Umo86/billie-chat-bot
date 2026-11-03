import Link from "next/link";
import { Note, Panel } from "@/components/ui/bits";
import { modelName, PRICES_CHECKED, usd } from "@/lib/ai/pricing";
import { cn } from "@/lib/utils";

type Totals = {
  requests: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
};

const n = (x: number) => Math.round(x).toLocaleString("en-GB");
const tokensIn = (t: Totals) => t.input + t.cacheWrite + t.cacheRead;

const dayFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const dayLabel = (d: string) => dayFmt.format(new Date(`${d}T12:00:00Z`));

/**
 * Claude use and its cost (Settings → AI). Server-rendered: the bars' details
 * show on hover and keyboard focus with CSS, and the same numbers are in
 * the table below the chart.
 */
export function AiUsage({
  periods,
  period,
  report,
}: {
  periods: { key: string; label: string }[];
  period: string;
  report: {
    from: string;
    to: string;
    totals: Totals;
    byModel: (Totals & { model: string })[];
    byScope: (Totals & { scope: string; label: string })[];
    days: (Totals & { day: string })[];
    unpriced: number;
  };
}) {
  const t = report.totals;
  const max = Math.max(...report.days.map((d) => d.cost), 0);
  const tiles = [
    { label: "Cost (Claude credits)", value: usd(t.cost), lead: true },
    { label: "Requests", value: n(t.requests) },
    {
      label: "Tokens in",
      value: n(tokensIn(t)),
      sub: t.cacheRead ? `${n(t.cacheRead)} read from the cache` : null,
    },
    { label: "Tokens out", value: n(t.output) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <nav
        aria-label="Period"
        className="flex flex-wrap gap-1 self-start rounded-[10px] bg-muted p-1"
      >
        {periods.map((p) => (
          <Link
            key={p.key}
            href={`/settings?tab=ai&period=${p.key}`}
            aria-current={p.key === period ? "page" : undefined}
            className={cn(
              "rounded-[7px] px-3 py-1.5 text-[0.92rem] font-semibold text-muted-foreground",
              p.key === period && "bg-card text-foreground shadow-sm",
            )}
          >
            {p.label}
          </Link>
        ))}
      </nav>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="ai-totals">
        {tiles.map((tile) => (
          <Panel key={tile.label} className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-muted-foreground">{tile.label}</span>
            <span
              className={cn(
                "font-[family-name:var(--font-display)] font-extrabold tabular-nums",
                tile.lead ? "text-[1.9rem]" : "text-[1.5rem]",
              )}
            >
              {tile.value}
            </span>
            {tile.sub ? (
              <span className="text-[0.8rem] text-muted-foreground">{tile.sub}</span>
            ) : null}
          </Panel>
        ))}
      </div>

      {report.days.length > 1 ? (
        <Panel className="flex flex-col gap-3">
          <h2 className="text-[1.05rem]">Cost per day</h2>
          {max > 0 ? (
            <>
              <div className="flex items-end gap-0.5" style={{ height: 140 }} role="list">
                {report.days.map((d) => {
                  const h = d.cost ? Math.max(2, Math.round((d.cost / max) * 132)) : 0;
                  return (
                    <div
                      key={d.day}
                      role="listitem"
                      tabIndex={0}
                      aria-label={`${dayLabel(d.day)}: ${usd(d.cost)}, ${n(d.requests)} requests`}
                      className="group relative flex h-full min-w-0 flex-1 items-end justify-center outline-none"
                    >
                      <div
                        className="w-full max-w-6 rounded-t-[4px] bg-primary group-hover:brightness-110 group-focus-visible:ring-2 group-focus-visible:ring-primary/40"
                        style={{ height: h }}
                      />
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-[8px] border border-border bg-card px-2.5 py-1.5 text-[0.8rem] whitespace-nowrap shadow-panel group-hover:block group-focus-visible:block">
                        <span className="block font-bold tabular-nums">{usd(d.cost)}</span>
                        <span className="block text-muted-foreground">
                          {dayLabel(d.day)} · {n(d.requests)} requests
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between border-t border-border pt-1 text-[0.8rem] text-muted-foreground">
                <span>{dayLabel(report.from)}</span>
                <span>Highest: {usd(max)}</span>
                <span>{dayLabel(report.to)}</span>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer font-semibold text-primary">
                  Show as a table
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[360px] text-left">
                    <thead className="text-[0.8rem] text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-3 font-semibold">Day</th>
                        <th className="py-1 pr-3 text-right font-semibold">Requests</th>
                        <th className="py-1 text-right font-semibold">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {report.days.map((d) => (
                        <tr key={d.day} className="border-t border-border">
                          <td className="py-1 pr-3">{dayLabel(d.day)}</td>
                          <td className="py-1 pr-3 text-right">{n(d.requests)}</td>
                          <td className="py-1 text-right">{usd(d.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No cost recorded in this period.</p>
          )}
        </Panel>
      ) : null}

      <Breakdown
        title="By model"
        rows={report.byModel.map((m) => ({
          key: m.model || "none",
          label: modelName(m.model),
          ...m,
          unpriced: m.model === "",
        }))}
        testId="ai-by-model"
      />
      <Breakdown
        title="By what it was for"
        rows={report.byScope.map((s) => ({ key: s.scope, ...s, unpriced: false }))}
        testId="ai-by-use"
      />

      <Note>
        Costs are Billie&apos;s own count, worked out for each request from Anthropic&apos;s list
        prices (checked {PRICES_CHECKED}), in US dollars, which is what Claude credits are. The
        bill, and anything else on the same Claude account, is in the Claude Console.
        {report.unpriced
          ? ` ${n(report.unpriced)} ${report.unpriced === 1 ? "request" : "requests"} from before Billie recorded models show tokens but no cost.`
          : ""}
      </Note>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  testId,
}: {
  title: string;
  rows: (Totals & { key: string; label: string; unpriced: boolean })[];
  testId: string;
}) {
  return (
    <Panel className="flex flex-col gap-2" data-testid={testId}>
      <h2 className="text-[1.05rem]">{title}</h2>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-[0.8rem] text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-semibold">
                  {title === "By model" ? "Model" : "Use"}
                </th>
                <th className="py-1.5 pr-3 text-right font-semibold">Requests</th>
                <th className="py-1.5 pr-3 text-right font-semibold">Tokens in</th>
                <th className="py-1.5 pr-3 text-right font-semibold">From cache</th>
                <th className="py-1.5 pr-3 text-right font-semibold">Tokens out</th>
                <th className="py-1.5 text-right font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-border">
                  <td className="py-1.5 pr-3 font-semibold">{r.label}</td>
                  <td className="py-1.5 pr-3 text-right">{n(r.requests)}</td>
                  <td className="py-1.5 pr-3 text-right">{n(tokensIn(r))}</td>
                  <td className="py-1.5 pr-3 text-right">{n(r.cacheRead)}</td>
                  <td className="py-1.5 pr-3 text-right">{n(r.output)}</td>
                  <td className="py-1.5 text-right">{r.unpriced ? "Not recorded" : usd(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing in this period.</p>
      )}
    </Panel>
  );
}
