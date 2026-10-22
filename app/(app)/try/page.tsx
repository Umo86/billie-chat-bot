import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState, PageHeader } from "@/components/ui/bits";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { requireActor } from "@/lib/auth/actor";
import { botCards } from "@/lib/bots/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Try a bot" };

/**
 * Try any bot, draft or live, exactly as a visitor sees it: the real chat
 * frame on a stand-in web page. Test chats are marked and kept out of reports.
 */
export default async function TryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireActor("bots.view");
  const bots = await botCards();
  const { bot: wanted } = await searchParams;
  const bot = bots.find((b) => b.slug === wanted) ?? bots[0];

  if (!bot)
    return (
      <>
        <PageHeader title="Try a bot" />
        <EmptyState
          title="No bots yet"
          action={
            <Button asChild variant="primary">
              <Link href="/bots/new">
                <Plus /> New bot
              </Link>
            </Button>
          }
        >
          Create a bot first, then try it here exactly as visitors will see it.
        </EmptyState>
      </>
    );

  return (
    <>
      <PageHeader
        title="Try a bot"
        lede="The real chat, as visitors see it on a website. Test chats are marked TEST and left out of reports."
      />
      <nav aria-label="Bots" className="flex flex-wrap gap-2">
        {bots.map((b) => (
          <Link
            key={b.id}
            href={`/try?bot=${b.slug}`}
            aria-current={b.id === bot.id ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-3 font-semibold hover:border-primary/50",
              b.id === bot.id && "border-primary bg-accent",
            )}
          >
            <BotAvatar name={b.name} color={b.color} avatarUrl={b.avatarUrl} size={28} />
            {b.name}
            <Chip tone={b.status === "live" ? "good" : "neutral"}>
              {b.status === "live" ? "Live" : "Draft"}
            </Chip>
          </Link>
        ))}
      </nav>
      <div className="overflow-hidden rounded-[14px] border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2">
          <span className="size-2.5 rounded-full bg-bad/60" aria-hidden />
          <span className="size-2.5 rounded-full bg-warn/60" aria-hidden />
          <span className="size-2.5 rounded-full bg-good/60" aria-hidden />
          <span className="ml-2 truncate rounded-md bg-card px-2 py-0.5 font-mono text-[0.78rem] text-muted-foreground">
            {bot.audience === "visitors"
              ? "your-show-website.com"
              : "exhibitor-manual.your-show.com"}
          </span>
        </div>
        <div className="grid min-h-[680px] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="hidden flex-col gap-4 p-8 lg:flex" aria-hidden>
            <div className="h-7 w-2/3 rounded bg-muted" />
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-11/12 rounded bg-muted" />
            <div className="h-4 w-4/5 rounded bg-muted" />
            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="h-28 rounded-lg bg-muted" />
              <div className="h-28 rounded-lg bg-muted" />
              <div className="h-28 rounded-lg bg-muted" />
            </div>
            <div className="h-4 w-3/4 rounded bg-muted" />
            <div className="h-4 w-2/3 rounded bg-muted" />
          </div>
          <div className="border-border lg:border-l">
            <iframe
              key={bot.slug}
              src={`/embed/${bot.slug}?try=1`}
              title={`Chat with ${bot.name}`}
              className="block h-[680px] w-full border-0"
            />
          </div>
        </div>
      </div>
    </>
  );
}
