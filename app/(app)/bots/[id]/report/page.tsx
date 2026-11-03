import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, PageHeader, Panel } from "@/components/ui/bits";
import { Field, Input } from "@/components/ui/form";
import { requireActor } from "@/lib/auth/actor";
import { mayOnBot } from "@/lib/auth/bots";
import { can } from "@/lib/authz";
import { botById } from "@/lib/bots/load";
import { dayLabel, rangeLabel } from "@/lib/bots/show-days";
import { usd, usdFine } from "@/lib/ai/pricing";
import { reportRange, showReport } from "@/lib/reports/show-report";
import { MINUTES_SAVED } from "@/lib/reports/bot-week";

export const metadata: Metadata = { title: "End-of-show report" };

const fmt = new Intl.NumberFormat("en-GB");

/**
 * One bot's end-of-show report: its show days (or the days chosen), on a
 * page and as a PDF to send round.
 */
export default async function ShowReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor("reports.view");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const bot = await botById(id);
  if (!bot || !(await mayOnBot(actor, "reports.view", bot.id))) notFound();
  const range = reportRange(bot, { from: sp.from, to: sp.to });
  // What Claude cost, for admins (as everywhere else in Billie).
  const r = (await showReport(bot.id, range, { withCost: can(actor, "settings.manage") }))!;
  const query = `from=${r.from}&to=${r.to}`;

  const tiles = [
    { n: fmt.format(r.chats), label: "chats" },
    { n: r.alonePct === null ? "–" : `${r.alonePct}%`, label: "answered by Billie alone" },
    { n: fmt.format(r.handedOver), label: "passed to the team" },
    { n: String(r.hours), label: "hours saved (about)" },
    { n: fmt.format(r.emails), label: "emails in" },
    { n: fmt.format(r.emailsDrafted), label: "email replies drafted" },
    { n: fmt.format(r.requests), label: "requests from chats" },
    r.costPerChatMicros !== null
      ? {
          n: usdFine(r.costPerChatMicros),
          label: `Claude cost a chat (${usd(r.costMicros ?? 0)} in all)`,
        }
      : {
          n: r.helpfulPct === null ? "–" : `${r.helpfulPct}%`,
          label: "of rated answers were helpful",
        },
  ];
  const peak = Math.max(1, ...r.days.map((d) => d.chats));

  return (
    <>
      <PageHeader
        title="End-of-show report"
        lede={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Link href={`/bots/${bot.id}`} className="font-semibold text-primary">
              {bot.name}
            </Link>
            {bot.showName ? <span>· {bot.showName}</span> : null}
            <span>· {rangeLabel({ from: r.from, to: r.to })}</span>
          </span>
        }
        actions={
          <Button asChild variant="primary">
            <a href={`/bots/${bot.id}/report/pdf?${query}`} download>
              <Download /> Download PDF
            </a>
          </Button>
        }
      />

      {!r.usesShowDays && !sp.from ? (
        <Note>
          {bot.name} has no show days yet, so this is the last 30 days. Set them on its{" "}
          <Link href={`/bots/${bot.id}?step=look`} className="font-semibold text-primary">
            Look step
          </Link>{" "}
          (first day of build-up to last day of breakdown), or choose the days below.
        </Note>
      ) : null}

      <form className="flex flex-wrap items-end gap-3" method="get" aria-label="Days">
        <Field id="report-from" label="From">
          <Input id="report-from" name="from" type="date" defaultValue={r.from} required />
        </Field>
        <Field id="report-to" label="To">
          <Input id="report-to" name="to" type="date" defaultValue={r.to} required />
        </Field>
        <Button type="submit">Show these days</Button>
        {r.usesShowDays ? <Chip tone="accent">The show days</Chip> : null}
      </form>

      <div
        className="grid grid-cols-2 gap-3 md:grid-cols-4"
        data-testid="report-tiles"
        aria-label="The numbers"
      >
        {tiles.map((t) => (
          <Panel key={t.label} className="flex flex-col gap-1 p-4 sm:p-4">
            <span className="text-[1.6rem] font-extrabold leading-tight">{t.n}</span>
            <span className="text-sm text-muted-foreground">{t.label}</span>
          </Panel>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Hours saved counts {MINUTES_SAVED.chat} minutes for each chat Billie answered alone and{" "}
        {MINUTES_SAVED.email} for each email reply it drafted.
        {r.whatsapp ? ` ${fmt.format(r.whatsapp)} of the chats were on WhatsApp.` : ""}
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel className="flex flex-col gap-3">
          <h2 className="text-[1.05rem]">Chats each day</h2>
          {r.days.length ? (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Chats each day, and how many went to the team</caption>
              <thead className="text-[0.8rem] text-muted-foreground">
                <tr>
                  <th className="py-1.5 font-semibold">Day</th>
                  <th className="py-1.5 font-semibold">Chats</th>
                  <th className="py-1.5 font-semibold">Passed to the team</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {r.days.map((d) => (
                  <tr key={d.day}>
                    <td className="py-1.5 pr-3">{dayLabel(d.day)}</td>
                    <td className="py-1.5 pr-3">
                      <span className="flex items-center gap-2">
                        <span
                          className="h-2 rounded-full bg-primary"
                          style={{ width: `${Math.max(4, (d.chats / peak) * 120)}px` }}
                          aria-hidden
                        />
                        {fmt.format(d.chats)}
                      </span>
                    </td>
                    <td className="py-1.5">{fmt.format(d.handedOver)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-muted-foreground">No chats on these days.</p>
          )}
        </Panel>

        <Panel className="flex flex-col gap-3">
          <h2 className="text-[1.05rem]">Most asked</h2>
          {r.mostAsked.length ? (
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
              {r.mostAsked.map((q) => (
                <li key={q.question} className="break-words">
                  {q.question}{" "}
                  <span className="text-muted-foreground">({fmt.format(q.times)})</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground">Nothing asked on these days.</p>
          )}
          {r.reasons.length ? (
            <>
              <h3 className="mt-2 text-[0.95rem] font-semibold">Why chats went to the team</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {r.reasons.map((x) => (
                  <li key={x.label}>
                    {x.label} <span className="text-muted-foreground">({fmt.format(x.n)})</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {r.requestsByType.length ? (
            <>
              <h3 className="mt-2 text-[0.95rem] font-semibold">Requests from chats</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {r.requestsByType.map((x) => (
                  <li key={x.name}>
                    {x.name} <span className="text-muted-foreground">({fmt.format(x.n)})</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Panel>
      </div>

      <Panel className="flex flex-col gap-3" data-testid="report-fix">
        <h2 className="text-[1.05rem]">To fix before the next show</h2>
        {!r.couldntAnswer.length && !r.unhelpful.length ? (
          <p className="text-muted-foreground">
            Nothing: every question had an answer, and none was marked unhelpful.
          </p>
        ) : null}
        {r.couldntAnswer.length ? (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-[0.95rem] font-semibold">Questions Billie couldn&apos;t answer</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {r.couldntAnswer.map((g) => (
                <li key={g.id}>
                  <Link
                    href={`/knowledge?tab=gaps#gap-${g.id}`}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {g.question}
                  </Link>
                  {g.askCount > 1 ? (
                    <span className="text-muted-foreground">
                      {" "}
                      (asked {fmt.format(g.askCount)} times)
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {r.unhelpful.length ? (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-[0.95rem] font-semibold">Answers people marked unhelpful</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {r.unhelpful.map((u) => (
                <li key={u.id}>
                  <Link
                    href={`/knowledge?tab=gaps#unhelpful-${u.id}`}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {u.question}
                  </Link>
                  {u.count > 1 ? (
                    <span className="text-muted-foreground"> ({fmt.format(u.count)} times)</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>
    </>
  );
}
