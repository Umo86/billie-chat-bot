"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel, type Tone } from "@/components/ui/bits";
import { Field, Input, Select } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import {
  deleteDeadlineAction,
  saveDeadlineAction,
  startRemindersAction,
} from "@/app/actions/exhibitors";
import { ANY_ANSWER, guessDone } from "@/lib/exhibitors/deadline-rules";

type Value = { value: string; count: number };
type Latest = {
  id: string;
  status: "drafting" | "ready" | "sending" | "sent" | "discarded" | "failed";
  count: number;
  sent: number;
  failed: number;
  when: string;
};
type Deadline = {
  id: string;
  name: string;
  dueOn: string;
  due: string;
  /** "in 12 days", "today", "passed 3 days ago" */
  left: string;
  column: string;
  doneValues: string[];
  remindDaysBefore: number;
  notDone: number;
  total: number;
  columnMissing: boolean;
  latest: Latest | null;
};

const REMIND = [
  { value: "7", label: "7 days before" },
  { value: "14", label: "14 days before" },
  { value: "3", label: "3 days before" },
  { value: "0", label: "Only when I ask" },
];

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

function doneText(d: { column: string; doneValues: string[] }) {
  return d.doneValues.includes(ANY_ANSWER)
    ? `"${d.column}" has any answer`
    : `"${d.column}" says ${d.doneValues.join(", ")}`;
}

const LATEST: Record<Latest["status"], { tone: Tone; label: string }> = {
  drafting: { tone: "info", label: "Writing" },
  ready: { tone: "warn", label: "Ready to check" },
  sending: { tone: "info", label: "Sending" },
  sent: { tone: "good", label: "Sent" },
  discarded: { tone: "neutral", label: "Discarded" },
  failed: { tone: "bad", label: "Not written" },
};

function latestLine(botId: string, l: Latest) {
  const link = (text: string) => (
    <Link href={`/bots/${botId}/reminders/${l.id}`} className="font-semibold text-primary">
      {text}
    </Link>
  );
  const what =
    l.status === "drafting"
      ? "Billie is writing the reminder."
      : l.status === "ready"
        ? link(`Check and send ${plural(l.count, "reminder", "reminders")}`)
        : l.status === "sending"
          ? link(`${l.sent} of ${plural(l.count, "reminder", "reminders")} sent so far`)
          : l.status === "sent"
            ? link(
                `${plural(l.sent, "reminder", "reminders")} sent ${l.when}${l.failed ? `, ${l.failed} not sent` : ""}`,
              )
            : l.status === "failed"
              ? link("See why")
              : `Discarded ${l.when}.`;
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <Chip tone={LATEST[l.status].tone}>{LATEST[l.status].label}</Chip> {what}
    </p>
  );
}

/**
 * Deadlines on the Exhibitors step: each says which column of the list shows
 * who has done it. Billie drafts reminders to the rest before the deadline
 * (or now, on request), for a person to check and send.
 */
export function DeadlinesPanel({
  botId,
  columns,
  values,
  filled,
  total,
  deadlines,
  hasList,
  canEdit,
  emailReady,
}: {
  botId: string;
  columns: string[];
  values: Record<string, Value[]>;
  filled: Record<string, number>;
  total: number;
  deadlines: Deadline[];
  hasList: boolean;
  canEdit: boolean;
  emailReady: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Deadline | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const run = useRunner();

  function draftNow(d: Deadline) {
    run.run(() => startRemindersAction({ deadlineId: d.id }), {
      done: (r) => {
        if (!r) return;
        toast.success(
          `Billie is writing ${plural(r.count, "reminder", "reminders")} for ${d.name}.`,
        );
        router.push(`/bots/${botId}/reminders/${r.batchId}`);
      },
    });
  }

  return (
    <Panel className="flex flex-col gap-3" data-testid="deadlines">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[1.05rem]">Deadlines</h2>
          <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
            For each deadline, pick the column of the list that shows who has done it. Before the
            deadline, Billie writes one reminder for everyone who hasn&apos;t, from the bot&apos;s
            knowledge. You check it and who it goes to, then send them all at once.
          </p>
        </div>
        {canEdit && hasList && !editing ? (
          <Button onClick={() => setEditing("new")}>
            <Plus /> Add a deadline
          </Button>
        ) : null}
      </div>

      {!hasList ? (
        <Note>Upload the exhibitor list first: each deadline uses one of its columns.</Note>
      ) : !columns.length ? (
        <Note>
          The list has no columns besides company, stand, contact and email. Add a column that shows
          who has done each thing, such as &ldquo;Stand plan approved&rdquo;, and upload it again.
        </Note>
      ) : null}
      {deadlines.length && !emailReady ? (
        <Note tone="warn">
          Email sending isn&apos;t set up yet (an admin adds RESEND_API_KEY and EMAIL_FROM). Billie
          can still write reminders, but they can&apos;t be sent.
        </Note>
      ) : null}

      {editing === "new" ? (
        <DeadlineForm
          key="new"
          botId={botId}
          columns={columns}
          values={values}
          filled={filled}
          total={total}
          onDone={() => setEditing(null)}
        />
      ) : null}

      {deadlines.length ? (
        <ul className="flex flex-col gap-2.5" aria-label="Deadlines">
          {deadlines.map((d) =>
            editing !== "new" && editing?.id === d.id ? (
              <li key={d.id}>
                <DeadlineForm
                  botId={botId}
                  columns={columns}
                  values={values}
                  filled={filled}
                  total={total}
                  initial={d}
                  onDone={() => setEditing(null)}
                />
              </li>
            ) : (
              <li
                key={d.id}
                className="flex flex-col gap-1.5 rounded-[12px] border border-border px-3.5 py-3"
                data-testid="deadline"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-[1rem] font-bold">{d.name}</h3>
                    <p className="text-sm text-muted-foreground">
                      Due {d.due} · {d.left}
                    </p>
                  </div>
                  {canEdit ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => draftNow(d)}
                        disabled={
                          run.pending ||
                          d.columnMissing ||
                          !d.notDone ||
                          d.latest?.status === "drafting" ||
                          d.latest?.status === "ready" ||
                          d.latest?.status === "sending"
                        }
                      >
                        <Send /> Draft reminders now
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(d)}>
                        <Pencil /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete ${d.name}`}
                        onClick={() => setConfirmDelete(d.id)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ) : null}
                </div>
                {d.columnMissing ? (
                  <Note tone="warn">
                    The list has no &ldquo;{d.column}&rdquo; column any more, so Billie won&apos;t
                    chase anyone. Edit the deadline, or upload a list with that column.
                  </Note>
                ) : (
                  <>
                    <p className="text-sm">
                      Done when {doneText(d)}.{" "}
                      <strong>
                        {d.notDone
                          ? `${plural(d.notDone, "exhibitor hasn't", "exhibitors haven't")} done it yet`
                          : "Everyone has done it"}
                      </strong>
                      {d.notDone ? ` (of ${d.total.toLocaleString("en-GB")}).` : "."}
                    </p>
                    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <CalendarClock className="size-4" aria-hidden />
                      {d.remindDaysBefore
                        ? `Billie drafts reminders ${d.remindDaysBefore} days before, for you to check.`
                        : "Billie drafts reminders only when you ask."}
                    </p>
                  </>
                )}
                {d.latest ? latestLine(botId, d.latest) : null}
                {confirmDelete === d.id ? (
                  <Note tone="warn">
                    <p>Delete {d.name}? Its reminders go too, sent or not.</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="dangerSolid"
                        disabled={run.pending}
                        onClick={() =>
                          run.run(() => deleteDeadlineAction({ id: d.id }), {
                            done: () => {
                              setConfirmDelete(null);
                              router.refresh();
                            },
                          })
                        }
                      >
                        Delete it
                      </Button>
                      <Button size="sm" onClick={() => setConfirmDelete(null)}>
                        Keep it
                      </Button>
                    </div>
                  </Note>
                ) : null}
              </li>
            ),
          )}
        </ul>
      ) : hasList && columns.length && editing !== "new" ? (
        <p className="text-sm text-muted-foreground">No deadlines yet.</p>
      ) : null}
    </Panel>
  );
}

function DeadlineForm({
  botId,
  columns,
  values,
  filled,
  total,
  initial,
  onDone,
}: {
  botId: string;
  columns: string[];
  values: Record<string, Value[]>;
  filled: Record<string, number>;
  total: number;
  initial?: Deadline;
  onDone: () => void;
}) {
  const router = useRouter();
  const save = useRunner();
  const [name, setName] = useState(initial?.name ?? "");
  const [dueOn, setDueOn] = useState(initial?.dueOn ?? "");
  const [column, setColumn] = useState(
    initial && columns.includes(initial.column) ? initial.column : "",
  );
  const [done, setDone] = useState<string[]>(initial?.doneValues ?? []);
  const [remind, setRemind] = useState(String(initial?.remindDaysBefore ?? 7));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const id = initial?.id ?? "new";

  const answers = (values[column] ?? []).filter((v) => v.value);
  const empty = total - (filled[column] ?? 0);
  const any = done.includes(ANY_ANSWER);
  const doneCount = any
    ? (filled[column] ?? 0)
    : answers.filter((v) => done.includes(v.value.toLowerCase())).reduce((n, v) => n + v.count, 0);

  function pickColumn(c: string) {
    setColumn(c);
    setDone(guessDone(values[c] ?? []));
  }

  function toggle(v: string) {
    setDone((d) =>
      d.includes(v) ? d.filter((x) => x !== v) : [...d.filter((x) => x !== ANY_ANSWER), v],
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    save.run(
      () =>
        saveDeadlineAction({
          botId,
          id: initial?.id,
          name,
          dueOn,
          column,
          doneValues: done,
          remindDaysBefore: Number(remind),
        }),
      {
        done: () => {
          onDone();
          router.refresh();
        },
        failed: (r) => {
          if (!r.ok && r.fieldErrors) setErrors(r.fieldErrors);
        },
      },
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-[12px] border border-primary/40 bg-accent/40 p-3.5"
      aria-label={initial ? `Edit ${initial.name}` : "New deadline"}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`dl-name-${id}`} label="What's due" error={errors.name}>
          <Input
            id={`dl-name-${id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Stand plan"
            maxLength={60}
            required
          />
        </Field>
        <Field id={`dl-due-${id}`} label="Due date" error={errors.dueOn}>
          <Input
            id={`dl-due-${id}`}
            type="date"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            required
          />
        </Field>
      </div>
      <Field
        id={`dl-column-${id}`}
        label="Which column shows who has done it?"
        hint="A column of your exhibitor list."
      >
        <Select
          id={`dl-column-${id}`}
          value={column}
          onChange={(e) => pickColumn(e.target.value)}
          required
        >
          <option value="" disabled>
            Choose a column
          </option>
          {columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      {column ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[0.9rem] font-semibold">
            Which answers mean they&apos;ve done it?
          </legend>
          {answers.length ? (
            <div className="flex flex-wrap gap-1.5">
              {answers.map((v) => {
                const key = v.value.toLowerCase();
                return (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-2 rounded-[9px] border border-border bg-card px-2.5 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent has-[:disabled]:opacity-60"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-primary)]"
                      checked={any || done.includes(key)}
                      disabled={any}
                      onChange={() => toggle(key)}
                    />
                    {v.value} <span className="text-muted-foreground">({v.count})</span>
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nobody has an answer in this column yet.
            </p>
          )}
          <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--color-primary)]"
              checked={any}
              onChange={() =>
                setDone(
                  any
                    ? guessDone(values[column] ?? []).filter((v) => v !== ANY_ANSWER)
                    : [ANY_ANSWER],
                )
              }
            />
            Any answer means done (for dates, references or names)
          </label>
          <p className="text-sm text-muted-foreground">
            {empty
              ? `${plural(empty, "exhibitor has", "exhibitors have")} no answer: they count as not done. `
              : ""}
            With these answers,{" "}
            <strong>
              {plural(Math.max(0, total - doneCount), "exhibitor hasn't", "exhibitors haven't")}
            </strong>{" "}
            done it.
          </p>
        </fieldset>
      ) : null}
      <Field
        id={`dl-remind-${id}`}
        label="When should Billie draft reminders?"
        hint="Nothing is sent until someone checks the reminders and sends them."
      >
        <Select id={`dl-remind-${id}`} value={remind} onChange={(e) => setRemind(e.target.value)}>
          {REMIND.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={save.pending || !column || !done.length}>
          {initial ? "Save deadline" : "Add deadline"}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
