import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen } from "lucide-react";
import { EmptyState, PageHeader, Panel } from "@/components/ui/bits";
import { TabsNav } from "@/components/ui/tabs-nav";
import { AddSource } from "@/components/knowledge/add-source";
import { SourceList } from "@/components/knowledge/source-list";
import { GapList } from "@/components/knowledge/gap-list";
import { KbActions, NewKbButton } from "@/components/knowledge/kb-dialog";
import { requireActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { knowledgeBaseList, openGaps, sourcesFor } from "@/lib/knowledge/queries";
import { ACCEPTED_EXTENSIONS, MAX_FILE_BYTES } from "@/lib/knowledge/files";
import { storageBackend } from "@/lib/storage";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Knowledge" };

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor("knowledge.view");
  const canEdit = can(actor, "knowledge.edit");
  const params = await searchParams;
  const tab = params.tab === "gaps" ? "gaps" : "bases";
  const [kbs, gaps] = await Promise.all([knowledgeBaseList(), openGaps()]);
  const selected = kbs.find((k) => k.id === params.kb) ?? kbs[0] ?? null;
  const sources = tab === "bases" && selected ? await sourcesFor(selected.id) : [];
  const storage = storageBackend();

  return (
    <>
      <PageHeader
        title="Knowledge"
        lede="What your bots know. Billie answers only from what's here, and passes anything else to the team."
        actions={
          canEdit && tab === "bases" && kbs.length ? <NewKbButton variant="default" /> : null
        }
      />
      <TabsNav
        label="Knowledge sections"
        current={tab}
        tabs={[
          { key: "bases", href: "/knowledge", label: "Knowledge bases" },
          {
            key: "gaps",
            href: "/knowledge?tab=gaps",
            label: `Unanswered questions${gaps.length ? ` (${gaps.length})` : ""}`,
          },
        ]}
      />

      {tab === "gaps" ? (
        <GapList gaps={gaps} kbs={kbs.map((k) => ({ id: k.id, name: k.name }))} canEdit={canEdit} />
      ) : !selected ? (
        <EmptyState title="No knowledge bases yet" action={canEdit ? <NewKbButton /> : null}>
          Start with two: one for exhibitors (the exhibitor manual, price lists, deadlines) and one
          for visitors (opening times, travel, tickets). Each bot answers from the ones you give it.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav aria-label="Knowledge bases" className="flex flex-col gap-1.5">
            {kbs.map((k) => (
              <Link
                key={k.id}
                href={`/knowledge?kb=${k.id}`}
                aria-current={k.id === selected.id ? "page" : undefined}
                className={cn(
                  "flex items-start gap-2.5 rounded-[12px] border border-border bg-card px-3.5 py-3 hover:border-primary/50",
                  k.id === selected.id && "border-primary bg-accent",
                )}
              >
                <BookOpen className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{k.name}</span>
                  <span className="block text-sm text-muted-foreground">
                    {k.sources} {k.sources === 1 ? "source" : "sources"} · {k.passages} passages
                  </span>
                </span>
              </Link>
            ))}
          </nav>
          <div className="flex min-w-0 flex-col gap-4">
            <Panel className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="break-words">{selected.name}</h2>
                {selected.description ? (
                  <p className="mt-1 text-muted-foreground">{selected.description}</p>
                ) : null}
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {selected.usedBy.length
                    ? `Used by ${selected.usedBy.map((b) => b.name).join(", ")}`
                    : "No bot uses this yet. Choose it in a bot's Knowledge step."}
                </p>
              </div>
              {canEdit ? (
                <KbActions
                  kb={{
                    id: selected.id,
                    name: selected.name,
                    description: selected.description,
                  }}
                  usedBy={selected.usedBy.length}
                />
              ) : null}
            </Panel>
            {canEdit ? (
              storage === "none" ? (
                <AddSource
                  kbId={selected.id}
                  accept={ACCEPTED_EXTENSIONS}
                  maxBytes={0}
                  blobUploads={false}
                  filesOff
                />
              ) : (
                <AddSource
                  kbId={selected.id}
                  accept={ACCEPTED_EXTENSIONS}
                  maxBytes={MAX_FILE_BYTES}
                  blobUploads={storage === "vercel-blob"}
                />
              )
            ) : null}
            <SourceList sources={sources} canEdit={canEdit} />
          </div>
        </div>
      )}
    </>
  );
}
