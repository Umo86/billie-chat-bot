"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Note, Panel } from "@/components/ui/bits";
import { Field, Input } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { useRunner } from "@/components/ui/use-runner";
import { saveBudgetAction } from "@/app/actions/settings";
import { cn } from "@/lib/utils";

/**
 * Settings → AI: what Claude may cost each month, how much of it is used so
 * far, and whether Billie stops at it. Admins get a Teams message at 80% and
 * at 100%.
 */
export function BudgetForm({
  initial,
  spent,
  month,
}: {
  initial: { dollars: number | null; hardStop: boolean };
  /** This month so far, formatted ("$12.34"), and the share of the budget. */
  spent: { label: string; pct: number | null };
  month: string;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(initial.dollars === null ? "" : String(initial.dollars));
  const [stop, setStop] = useState(initial.hardStop);
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = useRunner();
  const dollars = amount.trim() === "" ? null : Number(amount);
  const changed = dollars !== initial.dollars || (dollars !== null && stop !== initial.hardStop);
  const pct = spent.pct;
  const tone = pct === null ? "" : pct >= 100 ? "bg-bad" : pct >= 80 ? "bg-warn" : "bg-primary";

  return (
    <Panel className="flex flex-col gap-4" data-testid="ai-budget">
      <div>
        <h2 className="text-[1.05rem]">Monthly budget</h2>
        <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
          What Claude may cost in a calendar month, in US dollars as Anthropic bills. Admins get a
          Teams message at 80% and again at 100%.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-sm">
          <strong>{spent.label}</strong> used in {month}
          {pct !== null ? ` (${pct}% of the budget)` : ", with no budget set"}.
        </p>
        {pct !== null ? (
          <div
            className="h-2 w-full max-w-md overflow-hidden rounded-full bg-muted"
            role="meter"
            aria-label="Share of this month's budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(pct, 100)}
          >
            <div
              className={cn("h-full rounded-full", tone)}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
        ) : null}
        {pct !== null && pct >= 100 ? (
          <Note tone={initial.hardStop ? "bad" : "warn"}>
            {initial.hardStop
              ? "The budget is used up: Billie isn't using Claude until next month, or until the budget is raised. Chats go to the team, and email drafts wait."
              : "The budget is used up. Billie keeps answering because the stop is off."}
          </Note>
        ) : null}
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (dollars !== null && !(dollars >= 1))
            return setError("Set at least $1, or leave it empty.");
          run(() => saveBudgetAction({ dollars, hardStop: stop }), {
            failed: (r) => !r.ok && setError(r.fieldErrors?.dollars ?? null),
            done: () => router.refresh(),
          });
        }}
      >
        <Field
          id="budget-amount"
          label="Budget each month (US$)"
          hint="Leave it empty for no budget."
          error={error ?? undefined}
        >
          <Input
            id="budget-amount"
            inputMode="decimal"
            className="max-w-40"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="e.g. 50"
            aria-invalid={!!error}
          />
        </Field>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="budget-stop" className="font-semibold">
              Stop at the budget
            </label>
            <p className="max-w-[68ch] text-sm text-muted-foreground">
              Once the month&apos;s budget is used up, Billie stops using Claude: chats go to the
              team, and email drafts and suggested replies wait. Answers given again carry on, as
              they cost nothing. Off, Billie keeps answering and admins are only told.
            </p>
          </div>
          <Switch
            id="budget-stop"
            checked={stop && dollars !== null}
            disabled={pending || dollars === null}
            onCheckedChange={setStop}
          />
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={pending || !changed}>
            Save budget
          </Button>
        </div>
      </form>
    </Panel>
  );
}
