"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Note, Panel } from "@/components/ui/bits";
import { Field, Select } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { saveReminderPlanAction } from "@/app/actions/exhibitors";
import { planSummary, type ReminderPlan } from "@/lib/exhibitors/reminder-plan";

const REPEAT = [
  { value: 0, label: "Don't remind them again" },
  { value: 7, label: "Remind them again every week until it's done" },
  { value: 3, label: "Remind them again every 3 days until it's done" },
] as const;

const GAP = [
  { value: 1, label: "1 day" },
  { value: 2, label: "2 days" },
  { value: 3, label: "3 days" },
  { value: 7, label: "a week" },
] as const;

/**
 * How often a bot's deadline reminders go (Exhibitors step): one round, or
 * again every few days until it's done; whether repeats wait for a check;
 * the fewest days between two emails to one exhibitor; weekdays only.
 */
export function ReminderPlanPanel({
  botId,
  initial,
  canEdit,
  emailReady,
}: {
  botId: string;
  initial: ReminderPlan;
  canEdit: boolean;
  emailReady: boolean;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState<ReminderPlan>(initial);
  const { pending, run } = useRunner();
  const set = (patch: Partial<ReminderPlan>) => setPlan((p) => ({ ...p, ...patch }));
  const dirty = (Object.keys(plan) as (keyof ReminderPlan)[]).some((k) => plan[k] !== initial[k]);

  return (
    <Panel className="flex flex-col gap-3" data-testid="reminder-plan">
      <div>
        <h2 className="flex items-center gap-2 text-[1.05rem]">
          <Repeat className="size-5 text-primary" aria-hidden /> How often Billie reminds
        </h2>
        <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
          Each deadline says when its reminders start. This says what happens after that, for all of
          this bot&apos;s deadlines. Exhibitors signed in to the chat also see what they still have
          to do each time they open it.
        </p>
      </div>
      <Field id="rp-repeat" label="After the first round">
        <Select
          id="rp-repeat"
          value={String(plan.repeatDays)}
          disabled={!canEdit}
          onChange={(e) =>
            set({ repeatDays: Number(e.target.value) as ReminderPlan["repeatDays"] })
          }
        >
          {REPEAT.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      {plan.repeatDays ? (
        <>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-[0.9rem] font-semibold">Before a repeat goes</legend>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="rp-auto"
                className="mt-0.5 size-4 accent-[var(--color-primary)]"
                checked={!plan.autoSend}
                disabled={!canEdit}
                onChange={() => set({ autoSend: false })}
              />
              <span>
                <span className="font-semibold">Check each one first.</span> You get a message when
                it&apos;s ready, as with the first round.
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="rp-auto"
                className="mt-0.5 size-4 accent-[var(--color-primary)]"
                checked={plan.autoSend}
                disabled={!canEdit}
                onChange={() => set({ autoSend: true })}
              />
              <span>
                <span className="font-semibold">Send them automatically,</span> in the wording you
                checked and sent for the first round, to everyone who still hasn&apos;t done it.
              </span>
            </label>
          </fieldset>
          <Field
            id="rp-gap"
            label="Never more than one reminder email to an exhibitor in"
            hint="Across all deadlines. Anyone skipped gets the next round."
          >
            <Select
              id="rp-gap"
              value={String(plan.gapDays)}
              disabled={!canEdit}
              onChange={(e) => set({ gapDays: Number(e.target.value) as ReminderPlan["gapDays"] })}
            >
              {GAP.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </Select>
          </Field>
        </>
      ) : null}
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-[var(--color-primary)]"
          checked={plan.weekdaysOnly}
          disabled={!canEdit}
          onChange={(e) => set({ weekdaysOnly: e.target.checked })}
        />
        Only on weekdays
      </label>
      <p className="max-w-[68ch] text-sm" data-testid="reminder-plan-summary">
        <strong>In short:</strong> {planSummary(plan)}
      </p>
      {plan.repeatDays && plan.autoSend && !emailReady ? (
        <Note tone="warn">
          Email sending isn&apos;t set up yet, so nothing goes until an admin adds RESEND_API_KEY
          and EMAIL_FROM.
        </Note>
      ) : null}
      {canEdit ? (
        <div>
          <Button
            variant="primary"
            disabled={!dirty || pending}
            onClick={() =>
              run(() => saveReminderPlanAction({ botId, ...plan }), {
                done: () => router.refresh(),
              })
            }
          >
            Save how often
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
