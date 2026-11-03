"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Panel } from "@/components/ui/bits";
import { useRunner } from "@/components/ui/use-runner";
import { datesCheckedAction } from "@/app/actions/bots";
import { EditSourceDialog } from "@/components/knowledge/edit-source";
import type { DateGroup } from "@/lib/bots/copy";

/**
 * After copying a bot: every date in it, so the team checks each one for
 * the new show. Pasted text and typed answers can be fixed from here; files
 * and web pages are changed at the source and read again.
 */
export function DatesToCheck({
  botId,
  from,
  groups,
  canEdit,
}: {
  botId: string;
  from: string | null;
  groups: DateGroup[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const { pending, run } = useRunner();
  const total = groups.reduce((n, g) => n + g.dates.length, 0);

  return (
    <Panel className="flex flex-col gap-3 border-warn/60" data-testid="dates-to-check">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[1.05rem]">
            <CalendarCheck className="size-5 text-primary" aria-hidden /> Dates to check
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {from ? `Copied from ${from}. ` : ""}
            {total
              ? `${total} ${total === 1 ? "date" : "dates"} came across with the copy. Check each one is right for this show, then run the test questions.`
              : "No dates came across with the copy. Run the test questions to check its answers."}
          </p>
        </div>
        {canEdit ? (
          <Button
            size="sm"
            variant="primary"
            disabled={pending}
            onClick={() =>
              run(() => datesCheckedAction({ id: botId }), { done: () => router.refresh() })
            }
          >
            Done: dates checked
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-2.5">
        {groups.map((g) => (
          <li key={`${g.kind}:${g.id}`} className="rounded-[12px] border border-border px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold break-words">{g.title}</p>
              {g.kind === "bot" ? (
                <span className="flex gap-3 text-sm">
                  <Link href={`/bots/${botId}?step=look`} className="font-semibold text-primary">
                    Look
                  </Link>
                  <Link href={`/bots/${botId}?step=test`} className="font-semibold text-primary">
                    Test questions
                  </Link>
                </span>
              ) : canEdit && (g.sourceKind === "text" || g.sourceKind === "qa") ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${g.title}`}
                  onClick={() => setEditing({ id: g.id, title: g.title })}
                >
                  <Pencil /> Edit
                </Button>
              ) : (
                <span className="text-sm text-muted-foreground">
                  Change it at the source, then read it again.
                </span>
              )}
            </div>
            <ul className="mt-2 flex flex-col gap-1.5">
              {g.dates.map((d, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <Chip className="h-5 shrink-0 text-[0.72rem]" tone="warn">
                    {d.text}
                  </Chip>
                  <span className="min-w-0 break-words text-muted-foreground">{d.snippet}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <EditSourceDialog source={editing} onClose={() => setEditing(null)} />
    </Panel>
  );
}
