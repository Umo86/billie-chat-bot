"use client";

import { BOT_TYPES, type BotType } from "@/lib/bots/defaults";
import { cn } from "@/lib/utils";

/**
 * Choosing the kind of chatbot: one for exhibitors, in BluePrint (the
 * exhibitor manual), or one for visitors, on the event website. Real radio
 * buttons, shown as two cards.
 */
export function BotTypeChoice({
  value,
  onChange,
  error,
  note,
}: {
  value: BotType | null;
  onChange: (v: BotType) => void;
  error?: string;
  /** What changes when an existing bot is switched. */
  note?: React.ReactNode;
}) {
  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-describedby={error ? "bot-type-error" : undefined}
    >
      <legend className="mb-1 text-[0.9rem] font-semibold">What kind of chatbot is it?</legend>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(["exhibitors", "visitors"] as const).map((t) => {
          const k = BOT_TYPES[t];
          return (
            <label
              key={t}
              className={cn(
                "flex min-w-0 cursor-pointer gap-3 rounded-[12px] border bg-card p-4 transition-colors hover:border-primary/60",
                value === t ? "border-primary ring-2 ring-primary/20" : "border-border",
              )}
            >
              <input
                type="radio"
                name="bot-type"
                value={t}
                checked={value === t}
                onChange={() => onChange(t)}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-semibold">{k.label}</span>
                <span className="text-sm font-medium text-primary">{k.where}</span>
                <span className="text-sm text-muted-foreground">
                  {k.about} {k.outOfHours}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p className="text-sm text-bad" role="alert" id="bot-type-error">
          {error}
        </p>
      ) : null}
      {note}
    </fieldset>
  );
}
