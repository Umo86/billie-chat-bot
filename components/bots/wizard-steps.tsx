import Link from "next/link";
import { cn } from "@/lib/utils";

export const STEPS = [
  { key: "look", label: "Look" },
  { key: "personality", label: "Personality" },
  { key: "knowledge", label: "Knowledge" },
  { key: "exhibitors", label: "Exhibitors" },
  { key: "rules", label: "Rules" },
  { key: "people", label: "People" },
  { key: "email", label: "Email" },
  { key: "test", label: "Test" },
  { key: "live", label: "Go live" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];
type Audience = "visitors" | "exhibitors";

/** The steps a bot has: only exhibitor bots have an exhibitor list. */
export function stepsFor(audience?: Audience) {
  return STEPS.filter((s) => s.key !== "exhibitors" || audience === "exhibitors");
}

/** The step after this one, for "Save and continue". */
export function nextStep(current: StepKey, audience?: Audience): StepKey {
  const steps = stepsFor(audience);
  const i = steps.findIndex((s) => s.key === current);
  return steps[Math.min(i + 1, steps.length - 1)].key;
}

/** The bot's steps; each is a link once the bot exists. */
export function WizardSteps({
  current,
  botId,
  audience,
}: {
  current: StepKey;
  botId?: string;
  audience?: Audience;
}) {
  return (
    <nav aria-label="Steps" className="overflow-x-auto">
      <ol className="flex min-w-max gap-1.5">
        {stepsFor(audience).map((s, i) => {
          const on = s.key === current;
          const body = (
            <>
              <span
                className={cn(
                  "grid size-6 place-items-center rounded-full text-[0.78rem] font-extrabold",
                  on ? "bg-primary-foreground text-primary" : "bg-muted text-muted-foreground",
                )}
              >
                {i + 1}
              </span>
              {s.label}
            </>
          );
          const cls = cn(
            "flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.92rem] font-semibold",
            on
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-muted-foreground",
            botId && !on && "hover:border-primary/50 hover:text-foreground",
          );
          return (
            <li key={s.key}>
              {botId ? (
                <Link
                  href={`/bots/${botId}?step=${s.key}`}
                  aria-current={on ? "step" : undefined}
                  className={cls}
                >
                  {body}
                </Link>
              ) : (
                <span aria-current={on ? "step" : undefined} className={cls}>
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
