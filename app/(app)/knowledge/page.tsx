import type { Metadata } from "next";
import Link from "next/link";
import { Archive, Bot, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState, PageHeader, Panel } from "@/components/ui/bits";
import { TabsNav } from "@/components/ui/tabs-nav";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { GapList } from "@/components/knowledge/gap-list";
import { DeleteOldKb } from "@/components/knowledge/kb-dialog";
import { ReplaceDialog } from "@/components/knowledge/replace-dialog";
import { KnowledgeWorkspace } from "@/components/knowledge/workspace";
import { requireActor } from "@/lib/auth/actor";
import { mayOnBot, myBotIds } from "@/lib/auth/bots";
import { can } from "@/lib/authz";
import { ensureBotKnowledgeBases } from "@/lib/knowledge/bases";
import { knowledgeBaseList, openGaps } from "@/lib/knowledge/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Knowledge" };
// The knowledge check starts straight after it's asked for, in this page's function.
export const maxDuration = 300;

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor("knowledge.view");
  const params = await searchParams;
  const tab = params.tab === "gaps" ? "gaps" : "bases";
  await ensureBotKnowledgeBases();
  const ids = await myBotIds(actor);
  const [kbs, gaps] = await Promise.all([knowledgeBaseList(ids), openGaps(ids)]);
  const selected =
    kbs.find((k) => k.id === params.kb) ??
    kbs.find((k) => k.bot && k.bot.id === params.bot) ??
    kbs[0] ??
    null;
  const owned = kbs.filter((k) => k.bot);
  const old = kbs.filter((k) => !k.bot);
  // Editing goes by the bot: an old shared base (no bot) is for admins only.
  const canEdit = selected
    ? await mayOnBot(actor, "knowledge.edit", selected.bot?.id ?? null)
    : can(actor, "knowledge.edit");

  return (
    <>
      <PageHeader
        title="Knowledge"
        lede="What each bot knows. A bot answers only from its own knowledge, and passes anything else to the team."
      />
      <TabsNav
        label="Knowledge sections"
        current={tab}
        tabs={[
          { key: "bases", href: "/knowledge", label: "Each bot's knowledge" },
          {
            key: "gaps",
            href: "/knowledge?tab=gaps",
            label: `Unanswered questions${gaps.length ? ` (${gaps.length})` : ""}`,
          },
        ]}
      />

      {tab === "gaps" ? (
        <GapList gaps={gaps} canEdit={can(actor, "knowledge.edit")} />
      ) : !selected ? (
        <EmptyState
          title={ids === null ? "No bots yet" : "You're not on any bots yet"}
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
          {ids === null
            ? "Each bot has its own knowledge. Create a bot, then add the exhibitor manual, price lists and the show's FAQ to it."
            : "You see the knowledge of the bots you work on. An admin can put you on a bot, or you can create one."}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav aria-label="Bots" className="flex flex-col gap-1.5">
            {owned.map((k) => (
              <KbLink key={k.id} kb={k} current={k.id === selected.id} />
            ))}
            {old.length ? (
              <>
                <p className="mt-3 px-1 text-sm font-semibold text-muted-foreground">
                  Not used by a bot
                </p>
                {old.map((k) => (
                  <KbLink key={k.id} kb={k} current={k.id === selected.id} />
                ))}
              </>
            ) : null}
          </nav>
          <div className="flex min-w-0 flex-col gap-4">
            <Panel className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="break-words">{selected.name}</h2>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {selected.bot
                    ? `${selected.bot.status === "live" ? "Live" : "Draft"} bot. It answers only from what's here.`
                    : "No bot answers from this. Each bot has its own knowledge now: add anything you still need to a bot, then delete this."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {selected.bot ? (
                  <>
                    {canEdit ? <ReplaceDialog kbId={selected.id} kbName={selected.name} /> : null}
                    {can(actor, "bots.view") ? (
                      <Button asChild size="sm">
                        <Link href={`/bots/${selected.bot.id}`}>
                          <Bot /> Open the bot
                        </Link>
                      </Button>
                    ) : null}
                  </>
                ) : canEdit ? (
                  <DeleteOldKb kb={{ id: selected.id, name: selected.name }} />
                ) : null}
              </div>
            </Panel>
            <KnowledgeWorkspace
              kbId={selected.id}
              canEdit={canEdit}
              canAdd={canEdit && !!selected.bot}
            />
          </div>
        </div>
      )}
    </>
  );
}

function KbLink({
  kb,
  current,
}: {
  kb: Awaited<ReturnType<typeof knowledgeBaseList>>[number];
  current: boolean;
}) {
  return (
    <Link
      href={`/knowledge?kb=${kb.id}`}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex items-start gap-2.5 rounded-[12px] border border-border bg-card px-3.5 py-3 hover:border-primary/50",
        current && "border-primary bg-accent",
      )}
    >
      {kb.bot ? (
        <BotAvatar name={kb.bot.name} color={kb.bot.color} avatarUrl={kb.bot.avatarUrl} size={22} />
      ) : (
        <Archive className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-semibold">{kb.name}</span>
          {kb.bot?.status === "live" ? <Chip tone="good">Live</Chip> : null}
        </span>
        <span className="block text-sm text-muted-foreground">
          {kb.sources} {kb.sources === 1 ? "source" : "sources"} · {kb.passages}{" "}
          {kb.passages === 1 ? "passage" : "passages"}
        </span>
      </span>
    </Link>
  );
}
