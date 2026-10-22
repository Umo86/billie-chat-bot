import Link from "next/link";
import { cn } from "@/lib/utils";

export const STEPS = [
  { key: "look", label: "Look" },
  { key: "knowledge", label: "Knowledge" },
  { key: "rules", label: "Rules" },
  { key: "test", label: "Test" },
  { key: "live", label: "Go live" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

/** The five steps; each is a link once the bot exists. */
export function WizardSteps({ current, botId }: { current: StepKey; botId?: string }) {
  return (
    <nav aria-label="Steps" className="overflow-x-auto">
      <ol className="flex min-w-max gap-1.5">
        {STEPS.map((s, i) => {
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
