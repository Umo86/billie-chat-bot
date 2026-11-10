"use client";

import { useState } from "react";
import { Earth, Pencil, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Field, Input, Textarea } from "@/components/ui/form";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { useRunner } from "@/components/ui/use-runner";
import {
  recrawlWebsiteAction,
  removeWebsiteAction,
  updateWebsiteAction,
} from "@/app/actions/knowledge";
import type { WebsiteRow } from "@/lib/knowledge/websites";

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

function day(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

const WEEK = 7 * 86_400_000;
/** The weekly read comes with the daily tidy-up, a week after the last one. */
const nextRead = (lastIso: string) => new Date(Date.parse(lastIso) + WEEK).toISOString();
/** Changed in the last week: what the latest reads picked up. */
const changedLately = (iso: string | null, now: number) =>
  Boolean(iso) && now - Date.parse(iso!) < WEEK;

function when(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

/** Whole websites in this knowledge, each with its pages. */
export function WebsiteList({ sites, canEdit }: { sites: WebsiteRow[]; canEdit: boolean }) {
  if (!sites.length) return null;
  const busy = sites.some(
    (s) =>
      s.status === "finding" ||
      s.pages.some((p) => p.status === "queued" || p.status === "reading"),
  );
  return (
    <section className="flex flex-col gap-3" aria-label="Websites">
      <AutoRefresh active={busy} every={5000} />
      {sites.map((s) => (
        <Website key={s.id} site={s} canEdit={canEdit} />
      ))}
    </section>
  );
}

function Website({ site, canEdit }: { site: WebsiteRow; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { pending, run } = useRunner();
  const ready = site.pages.filter((p) => p.status === "ready").length;
  const failed = site.pages.filter((p) => p.status === "failed").length;
  const reading = site.pages.length - ready - failed;
  const [now] = useState(() => Date.now());
  const changed = site.pages.filter((p) => changedLately(p.changedAt, now)).length;

  return (
    <Panel className="flex flex-col gap-3" data-testid="website">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
          <Earth className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <h3 className="break-words text-[1rem] font-semibold">{site.host}</h3>
            <p className="text-sm text-muted-foreground">
              Whole website ·{" "}
              {site.status === "finding"
                ? "finding its pages…"
                : site.status === "failed" && site.lastCrawledAt
                  ? `last tried ${when(site.lastCrawledAt)}`
                  : site.lastCrawledAt
                    ? `read ${when(site.lastCrawledAt)} · reads itself again every week (next about ${day(nextRead(site.lastCrawledAt))})`
                    : "not read yet"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {site.pages.length ? (
            <Chip tone={failed ? "warn" : "good"}>
              {plural(ready, "page", "pages")} ready
              {reading ? ` · ${reading} reading` : ""}
              {failed ? ` · ${failed} couldn't be read` : ""}
            </Chip>
          ) : null}
          {canEdit ? (
            <>
              <Button
                size="sm"
                disabled={pending || site.status === "finding"}
                onClick={() => run(() => recrawlWebsiteAction({ id: site.id }))}
              >
                <RotateCw /> Read again now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
                <Pencil /> Change
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
                <Trash2 /> Remove
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {canEdit && site.status !== "failed" ? (
        <p className="text-sm text-muted-foreground">
          Changed the agenda or another page on the website? Press <b>Read again now</b> and Billie
          reads every page again. It takes a few minutes, and pages that haven&apos;t changed cost
          nothing.
          {changed
            ? ` ${plural(changed, "page has", "pages have")} changed in the last week.`
            : site.lastCrawledAt && site.status === "ready" && !reading
              ? " Nothing has changed in the last week."
              : ""}
        </p>
      ) : null}
      {site.status === "failed" ? <Note tone="bad">{site.note}</Note> : null}
      {site.status === "ready" && site.note ? (
        <p className="text-sm text-muted-foreground">Found {site.note}</p>
      ) : null}
      {site.leaveOut.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Leaving out pages with:</span>
          {site.leaveOut.map((w) => (
            <Chip key={w}>{w}</Chip>
          ))}
        </div>
      ) : null}

      {confirm ? (
        <Note tone="warn">
          <span className="flex flex-wrap items-center gap-2">
            <span>Remove {site.host}? Its pages go to the bin for 30 days.</span>
            <Button
              size="sm"
              variant="dangerSolid"
              disabled={pending}
              onClick={() => run(() => removeWebsiteAction({ id: site.id }))}
            >
              Yes, remove
            </Button>
            <Button size="sm" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </span>
        </Note>
      ) : null}

      {editing ? <EditWebsite site={site} onDone={() => setEditing(false)} /> : null}

      {site.pages.length ? (
        <details className="group">
          <summary className="cursor-pointer text-sm font-semibold text-primary">
            Show the {plural(site.pages.length, "page", "pages")}
          </summary>
          <ul
            className="mt-2 flex max-h-96 flex-col gap-1 overflow-y-auto text-sm"
            aria-label={`Pages of ${site.host}`}
          >
            {site.pages.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline gap-x-2">
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 break-all underline-offset-2 hover:underline"
                >
                  {p.title === p.url ? p.url : p.title}
                </a>
                {p.status === "failed" ? (
                  <span className="text-bad">{p.error ?? "Couldn't be read."}</span>
                ) : p.status !== "ready" ? (
                  <span className="text-muted-foreground">Reading…</span>
                ) : changedLately(p.changedAt, now) ? (
                  <span className="font-semibold text-good">Changed {day(p.changedAt!)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}

function EditWebsite({ site, onDone }: { site: WebsiteRow; onDone: () => void }) {
  const [leaveOut, setLeaveOut] = useState(site.leaveOut.join("\n"));
  const [max, setMax] = useState(String(site.maxPages));
  const { pending, run } = useRunner();
  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => updateWebsiteAction({ id: site.id, leaveOut, maxPages: Number(max) }), {
          done: onDone,
        });
      }}
    >
      <LeaveOutFields
        id={`site-${site.id}`}
        leaveOut={leaveOut}
        setLeaveOut={setLeaveOut}
        max={max}
        setMax={setMax}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          Save and look again
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

/** What to leave out and how many pages: the same on adding and changing a website. */
export function LeaveOutFields({
  id,
  leaveOut,
  setLeaveOut,
  max,
  setMax,
}: {
  id: string;
  leaveOut: string;
  setLeaveOut: (v: string) => void;
  max: string;
  setMax: (v: string) => void;
}) {
  return (
    <>
      <Field
        id={`${id}-leave-out`}
        label="Leave out pages whose address contains"
        hint="One per line, such as /news, /blog or /press. Billie only reads pages on this website."
      >
        <Textarea
          id={`${id}-leave-out`}
          value={leaveOut}
          onChange={(e) => setLeaveOut(e.target.value)}
          rows={3}
          maxLength={3000}
          placeholder={"/news\n/blog"}
        />
      </Field>
      <Field id={`${id}-max`} label="Most pages to read" hint="Up to 500.">
        <Input
          id={`${id}-max`}
          inputMode="numeric"
          className="max-w-32"
          value={max}
          onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))}
        />
      </Field>
    </>
  );
}
