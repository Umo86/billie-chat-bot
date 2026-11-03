"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Switch } from "@/components/ui/switch";
import { useRunner } from "@/components/ui/use-runner";
import { updateBotAction } from "@/app/actions/bots";
import {
  removeExhibitorListAction,
  saveHiddenColumnsAction,
  uploadExhibitorListAction,
} from "@/app/actions/exhibitors";

type Listed = {
  id: string;
  company: string;
  stand: string;
  name: string;
  emails: string[];
  fields: Record<string, string>;
};

type ExhibitorList = {
  fileName: string;
  rows: number;
  skipped: number;
  columns: string[];
  /** Columns Billie never reads about an exhibitor. */
  hiddenColumns: string[];
  /** "3 h ago, by Sam Patel" */
  uploaded: string;
  sample: Listed[];
};

const SAMPLE_COLUMNS = 4;
const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/**
 * An exhibitor bot's list of exhibitors (one row each, uploaded as a
 * spreadsheet), and whether exhibitors can sign in from the chat to ask about
 * their own stand. Only people who work on the bot see it.
 */
export function ExhibitorsStep({
  botId,
  botName,
  list,
  personalAnswers,
  emailReady,
  canEdit,
  next,
  nextLabel,
  children,
}: {
  botId: string;
  botName: string;
  list: ExhibitorList | null;
  personalAnswers: boolean;
  emailReady: boolean;
  canEdit: boolean;
  next: string;
  nextLabel: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [on, setOn] = useState(personalAnswers);
  const upload = useRunner();
  const remove = useRunner();
  const toggle = useRunner();

  function send(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    upload.run(() => uploadExhibitorListAction(form), {
      done: (d) => {
        if (d)
          toast.success(
            `Uploaded ${plural(d.rows, "exhibitor", "exhibitors")}.` +
              (d.skipped
                ? ` ${plural(d.skipped, "row", "rows")} without an email address left out.`
                : ""),
          );
        if (file.current) file.current.value = "";
        setChosen(null);
        router.refresh();
      },
    });
  }

  const extra = list?.columns.slice(0, SAMPLE_COLUMNS) ?? [];
  const waiting = !list
    ? "Upload the exhibitor list first."
    : !emailReady
      ? "Signing in needs email sending set up (an admin adds RESEND_API_KEY and EMAIL_FROM)."
      : null;

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-3" data-testid="exhibitor-list">
        <div>
          <h2 className="text-[1.05rem]">Exhibitor list</h2>
          <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
            One row per exhibitor, with headings in the first row. Billie needs an Email column (one
            address, or several separated by commas). It also looks for Company, Stand and Contact
            name. Every other column, such as Stand type, Electrics ordered, Stand plan approved or
            Build-up slot, is kept as it is.
          </p>
        </div>

        {list ? (
          <>
            <p>
              <strong>{list.fileName}</strong>: {plural(list.rows, "exhibitor", "exhibitors")},
              uploaded {list.uploaded}.
              {list.skipped
                ? ` ${plural(list.skipped, "row", "rows")} without an email address ${list.skipped === 1 ? "was" : "were"} left out.`
                : ""}
            </p>
            {list.columns.length ? (
              <ColumnsBillieUses
                key={`${list.fileName}:${list.uploaded}`}
                botId={botId}
                columns={list.columns}
                hidden={list.hiddenColumns}
                canEdit={canEdit}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No other columns: Billie only knows each exhibitor&apos;s company, stand and
                contact.
              </p>
            )}
            <div className="overflow-x-auto rounded-[10px] border border-border">
              <table className="w-full min-w-[560px] text-left text-sm">
                <caption className="sr-only">
                  The first {list.sample.length} exhibitors on the list
                </caption>
                <thead className="bg-muted text-[0.8rem] text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Company</th>
                    <th className="px-3 py-2 font-semibold">Stand</th>
                    <th className="px-3 py-2 font-semibold">Contact</th>
                    <th className="px-3 py-2 font-semibold">Email</th>
                    {extra.map((c) => (
                      <th key={c} className="px-3 py-2 font-semibold">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.sample.map((e) => (
                    <tr key={e.id} className="border-t border-border align-top">
                      <td className="px-3 py-2">{e.company || "–"}</td>
                      <td className="px-3 py-2">{e.stand || "–"}</td>
                      <td className="px-3 py-2">{e.name || "–"}</td>
                      <td className="px-3 py-2 break-all">{e.emails.join(", ")}</td>
                      {extra.map((c) => (
                        <td key={c} className="px-3 py-2">
                          {e.fields[c] || "–"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.rows > list.sample.length ? (
              <p className="text-sm text-muted-foreground">
                Showing {list.sample.length} of {list.rows.toLocaleString("en-GB")}.
              </p>
            ) : null}
          </>
        ) : (
          <Note>No list yet.</Note>
        )}

        {canEdit ? (
          <form onSubmit={send} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="botId" value={botId} />
            <label className="sr-only" htmlFor="exhibitor-file">
              Exhibitor list (Excel or CSV)
            </label>
            <input
              ref={file}
              id="exhibitor-file"
              name="file"
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              required
              onChange={(e) => setChosen(e.target.files?.[0]?.name ?? null)}
              className="min-w-0 max-w-full text-sm file:mr-3 file:cursor-pointer file:rounded-[9px] file:border file:border-border file:bg-card file:px-3 file:py-1.5 file:font-semibold"
            />
            <Button type="submit" variant="primary" disabled={upload.pending || !chosen}>
              <Upload /> {list ? "Upload a new list" : "Upload list"}
            </Button>
            {list && !confirmRemove ? (
              <Button variant="danger" onClick={() => setConfirmRemove(true)}>
                <Trash2 /> Remove list
              </Button>
            ) : null}
          </form>
        ) : null}
        {list && canEdit && !confirmRemove ? (
          <p className="text-sm text-muted-foreground">
            A new list replaces this one, and anyone signed in with the old one signs in again.
          </p>
        ) : null}
        {confirmRemove ? (
          <Note tone="warn">
            <p>
              Remove the list? Exhibitors can&apos;t sign in to {botName} until you upload one
              again.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="dangerSolid"
                disabled={remove.pending}
                onClick={() =>
                  remove.run(() => removeExhibitorListAction({ botId }), {
                    done: () => {
                      setConfirmRemove(false);
                      router.refresh();
                    },
                  })
                }
              >
                Remove it
              </Button>
              <Button size="sm" onClick={() => setConfirmRemove(false)}>
                Keep it
              </Button>
            </div>
          </Note>
        ) : null}
        <p className="text-sm text-muted-foreground">
          This is personal data. Only people who work on this bot see it. To find, copy or delete
          one exhibitor&apos;s row, use{" "}
          <Link href="/settings?tab=privacy" className="font-semibold text-primary">
            Settings → Privacy requests
          </Link>
          .
        </p>
      </Panel>

      <Panel className="flex flex-col gap-3" data-testid="personal-answers">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[1.05rem]">
              <label htmlFor="personal-answers">Answers about their own stand</label>
            </h2>
            <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
              Exhibitors tap <strong>Your stand</strong> in the chat and type the email they booked
              with. Billie emails them a six-digit code. Once they type it in, Billie answers from
              their row of the list: their stand, orders and times. It never shows anyone
              else&apos;s.
            </p>
          </div>
          <Switch
            id="personal-answers"
            checked={on}
            disabled={!canEdit || toggle.pending}
            onCheckedChange={(v) =>
              toggle.run(() => updateBotAction({ id: botId, personalAnswers: v }), {
                done: () => {
                  setOn(v);
                  router.refresh();
                },
              })
            }
          />
        </div>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {on && !waiting ? (
            <>
              <Chip tone="good">On</Chip> The chat shows a Your stand button.
            </>
          ) : on ? (
            <>
              <Chip tone="warn">Not yet</Chip> {waiting}
            </>
          ) : (
            <>
              <Chip>Off</Chip> Billie answers everyone from the knowledge only.
            </>
          )}
        </p>
        {!canEdit ? <Note>Only editors can change this.</Note> : null}
      </Panel>

      {children}

      <div>
        <Button asChild>
          <Link href={`/bots/${botId}?step=${next}`}>Continue to {nextLabel}</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * The other columns of the list, each ticked if Billie may read it when a
 * signed-in exhibitor asks about their stand. Notes for the team (credit
 * status, internal comments) stay unticked and never reach Billie.
 */
function ColumnsBillieUses({
  botId,
  columns,
  hidden,
  canEdit,
}: {
  botId: string;
  columns: string[];
  hidden: string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [off, setOff] = useState(() => new Set(hidden));
  const { pending, run } = useRunner();
  const changed = off.size !== hidden.length || hidden.some((h) => !off.has(h));
  return (
    <fieldset className="flex flex-col gap-2" data-testid="list-columns">
      <legend className="text-[0.9rem] font-semibold">Columns Billie may use</legend>
      <p className="max-w-[68ch] text-sm text-muted-foreground">
        When a signed-in exhibitor asks about their stand, Billie reads their row. Untick columns
        that are only for the team, such as notes or credit status: Billie never sees those. The
        deadline chasers can still use them.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {columns.map((c) => (
          <label key={c} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={!off.has(c)}
              disabled={!canEdit || pending}
              onChange={(e) =>
                setOff((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.delete(c);
                  else next.add(c);
                  return next;
                })
              }
            />
            {c}
          </label>
        ))}
      </div>
      {canEdit ? (
        <div>
          <Button
            size="sm"
            disabled={pending || !changed}
            onClick={() =>
              run(() => saveHiddenColumnsAction({ botId, hidden: [...off] }), {
                done: () => router.refresh(),
              })
            }
          >
            Save columns
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
