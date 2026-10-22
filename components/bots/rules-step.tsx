"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/bits";
import { Field, Input } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { ALWAYS_HUMAN_DEFAULT, CONTACT_FIELDS, FIELD_LABEL } from "@/lib/bots/defaults";
import { updateBotAction } from "@/app/actions/bots";
import type { BotRules, ContactField } from "@/lib/types";
import { cn } from "@/lib/utils";

const DAYS = [
  { d: 1, label: "Mon" },
  { d: 2, label: "Tue" },
  { d: 3, label: "Wed" },
  { d: 4, label: "Thu" },
  { d: 5, label: "Fri" },
  { d: 6, label: "Sat" },
  { d: 0, label: "Sun" },
];

export function RulesStep({
  botId,
  initial,
  canEdit,
}: {
  botId: string;
  initial: BotRules;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<BotRules>(initial);
  const [custom, setCustom] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, run } = useRunner();
  const topics = [...new Set([...ALWAYS_HUMAN_DEFAULT, ...rules.alwaysHuman])];

  const toggleTopic = (t: string) =>
    setRules((r) => ({
      ...r,
      alwaysHuman: r.alwaysHuman.includes(t)
        ? r.alwaysHuman.filter((x) => x !== t)
        : [...r.alwaysHuman, t],
    }));

  function save() {
    setErrors({});
    run(() => updateBotAction({ id: botId, rules }), {
      failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
      done: () => router.push(`/bots/${botId}?step=test`),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-3">
        <div>
          <h2 className="text-[1.05rem]">Always pass these to a person</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Billie won&apos;t answer these itself, even if the answer is in the knowledge.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {topics.map((t) => {
            const on = rules.alwaysHuman.includes(t);
            return (
              <button
                key={t}
                type="button"
                disabled={!canEdit}
                aria-pressed={on}
                onClick={() => toggleTopic(t)}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground",
                )}
              >
                {on ? "✓ " : ""}
                {t}
              </button>
            );
          })}
        </div>
        {canEdit ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const t = custom.trim();
              if (t && !rules.alwaysHuman.includes(t))
                setRules((r) => ({ ...r, alwaysHuman: [...r.alwaysHuman, t].slice(0, 20) }));
              setCustom("");
            }}
          >
            <Field id="custom-topic" label="Add a topic" className="min-w-0 flex-1 basis-56">
              <Input
                id="custom-topic"
                value={custom}
                maxLength={60}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="e.g. Rigging and hanging points"
              />
            </Field>
            <Button type="submit">
              <Plus /> Add
            </Button>
          </form>
        ) : null}
        {rules.alwaysHuman.filter((t) => !ALWAYS_HUMAN_DEFAULT.includes(t)).length ? (
          <ul className="flex flex-wrap gap-2 text-sm">
            {rules.alwaysHuman
              .filter((t) => !ALWAYS_HUMAN_DEFAULT.includes(t))
              .map((t) => (
                <li key={t}>
                  <button
                    type="button"
                    onClick={() => toggleTopic(t)}
                    className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${t}`}
                  >
                    <X className="size-3.5" /> {t}
                  </button>
                </li>
              ))}
          </ul>
        ) : null}
      </Panel>

      <Panel className="flex flex-col gap-3">
        <div>
          <h2 className="text-[1.05rem]">Team hours (UK time)</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Chats go to a person live only when someone has switched on &ldquo;Available&rdquo; in
            the Inbox. Outside these hours, Billie says when the team will reply.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
          {DAYS.map(({ d, label }) => {
            const on = rules.hours.days.includes(d);
            return (
              <button
                key={d}
                type="button"
                disabled={!canEdit}
                aria-pressed={on}
                onClick={() =>
                  setRules((r) => ({
                    ...r,
                    hours: {
                      ...r.hours,
                      days: on ? r.hours.days.filter((x) => x !== d) : [...r.hours.days, d],
                    },
                  }))
                }
                className={cn(
                  "w-14 cursor-pointer rounded-[9px] border py-1.5 text-sm font-semibold",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-3">
          <Field id="hours-start" label="From" error={errors["rules.hours.start"]}>
            <Input
              id="hours-start"
              type="time"
              value={rules.hours.start}
              disabled={!canEdit}
              onChange={(e) =>
                setRules((r) => ({ ...r, hours: { ...r.hours, start: e.target.value } }))
              }
              className="w-36"
            />
          </Field>
          <Field id="hours-end" label="To" error={errors["rules.hours.end"]}>
            <Input
              id="hours-end"
              type="time"
              value={rules.hours.end}
              disabled={!canEdit}
              onChange={(e) =>
                setRules((r) => ({ ...r, hours: { ...r.hours, end: e.target.value } }))
              }
              className="w-36"
            />
          </Field>
        </div>
      </Panel>

      <Panel className="flex flex-col gap-3">
        <div>
          <h2 className="text-[1.05rem]">When nobody is available</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Billie asks for these details so the team can reply later.
          </p>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {CONTACT_FIELDS.map((f: ContactField) => (
            <label key={f} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-primary)]"
                checked={rules.collect.includes(f)}
                disabled={!canEdit}
                onChange={(e) =>
                  setRules((r) => ({
                    ...r,
                    collect: e.target.checked
                      ? CONTACT_FIELDS.filter((x) => x === f || r.collect.includes(x))
                      : r.collect.filter((x) => x !== f),
                  }))
                }
              />
              {FIELD_LABEL[f]}
            </label>
          ))}
        </div>
        <Field
          id="promise"
          label="The team will reply…"
          hint={`Billie says: "Thanks, the team will reply ${rules.promise}."`}
          error={errors["rules.promise"]}
        >
          <Input
            id="promise"
            value={rules.promise}
            maxLength={60}
            disabled={!canEdit}
            onChange={(e) => setRules((r) => ({ ...r, promise: e.target.value }))}
          />
        </Field>
      </Panel>

      {canEdit ? (
        <div>
          <Button variant="primary" onClick={save} disabled={pending}>
            Save and continue
          </Button>
        </div>
      ) : null}
    </div>
  );
}
