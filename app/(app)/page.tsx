import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Code2, Pencil, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState, Note, PageHeader, Panel } from "@/components/ui/bits";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { requireActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { botCards, homeCounters } from "@/lib/bots/queries";
import { timeAgo } from "@/lib/time";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor();
  const params = await searchParams;
  const canBots = can(actor, "bots.view");
  const [counters, bots] = await Promise.all([
    homeCounters(),
    canBots ? botCards() : Promise.resolve([]),
  ]);

  const tiles = [
    { n: counters.waiting, label: "Chats waiting for a person", href: "/inbox" },
    { n: counters.emails, label: "Emails to check", href: "/emails" },
    ...(canBots
      ? [
          {
            n: counters.gaps,
            label: "Questions Billie couldn't answer",
            href: "/knowledge?tab=gaps",
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={canBots ? "Your bots" : `Hello, ${actor.name.split(" ")[0]}`}
        lede={
          canBots
            ? "Each bot answers from its own knowledge. Open one to edit it, test it or put it live."
            : "Chats and emails that need a person are waiting in the Inbox and Emails."
        }
        actions={
          can(actor, "bots.edit") ? (
            <Button asChild variant="primary">
              <Link href="/bots/new">
                <Plus /> New bot
              </Link>
            </Button>
          ) : null
        }
      />
      {params.denied ? (
        <Note tone="warn">
          Your role doesn&apos;t include that page. Ask an admin if you need it.
        </Note>
      ) : null}
      {params.welcome ? (
        <Note tone="good">
          You&apos;re set up. Start by creating your first bot, then invite the team in Settings.
        </Note>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {tiles.map((t) => (
          <Link
            key={t.label}
            href={t.href}
            className="flex items-center gap-4 rounded-[14px] border border-border bg-card px-5 py-4 hover:border-primary/50"
          >
            <span className="font-[family-name:var(--font-display)] text-[1.75rem] font-extrabold tabular-nums">
              {t.n}
            </span>
            <span className="font-semibold">{t.label}</span>
          </Link>
        ))}
      </div>

      {canBots ? (
        bots.length ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {bots.map((b) => (
              <Panel key={b.id} className="flex flex-col gap-4" data-testid="bot-card">
                <div className="flex items-start gap-3">
                  <BotAvatar name={b.name} color={b.color} avatarUrl={b.avatarUrl} size={46} />
                  <div className="min-w-0">
                    <h2 className="truncate">{b.name}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Chip tone={b.status === "live" ? "good" : "neutral"}>
                        {b.status === "live" ? "Live" : "Draft"}
                      </Chip>
                      <Chip tone="accent">
                        {b.audience === "visitors" ? "Visitors" : "Exhibitors"}
                      </Chip>
                      {b.showName ? (
                        <span className="text-sm text-muted-foreground">{b.showName}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3">
                  {[
                    [b.chats7d, "chats, last 7 days"],
                    [b.handed7d, "passed to the team"],
                    [b.passages, "passages of knowledge"],
                  ].map(([n, l]) => (
                    <div key={String(l)}>
                      <dt className="sr-only">{l}</dt>
                      <dd className="font-[family-name:var(--font-display)] text-xl font-extrabold tabular-nums">
                        {n}
                      </dd>
                      <dd className="text-sm text-muted-foreground">{l}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-sm text-muted-foreground">
                  {b.lastTestRun?.total
                    ? `Last test: ${b.lastTestRun.passed} of ${b.lastTestRun.total} passed, ${timeAgo(b.lastTestRun.at)}.`
                    : "Not tested yet."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm">
                    <Link href={`/bots/${b.id}`}>
                      <Pencil /> Edit
                    </Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href={`/bots/${b.id}?step=test`}>
                      <CheckCircle2 /> Test
                    </Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href={`/bots/${b.id}?step=live`}>
                      <Code2 /> Get code
                    </Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href={`/try?bot=${b.slug}`}>
                      <Play /> Try it
                    </Link>
                  </Button>
                </div>
              </Panel>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No bots yet"
            action={
              can(actor, "bots.edit") ? (
                <Button asChild variant="primary">
                  <Link href="/bots/new">
                    <Plus /> New bot
                  </Link>
                </Button>
              ) : null
            }
          >
            Create one for exhibitors and one for visitors. Each takes about 15 minutes once your
            documents are ready.
          </EmptyState>
        )
      ) : null}
    </>
  );
}
