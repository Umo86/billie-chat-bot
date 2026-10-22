import * as React from "react";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "signal" | "accent";

const tones: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
  signal: "bg-signal text-signal-foreground",
  accent: "bg-accent text-accent-foreground",
};

/** Status shown as a short word on a solid chip (never colour alone). */
export function Chip({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[0.75rem] font-bold tracking-[0.02em]",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Panel({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("min-w-0 rounded-[14px] border border-border bg-card p-4 sm:p-5", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function Note({
  tone = "neutral",
  className,
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad";
  className?: string;
  children: React.ReactNode;
}) {
  const t = { neutral: "bg-muted", good: "bg-good-soft", warn: "bg-warn-soft", bad: "bg-bad-soft" }[
    tone
  ];
  return (
    <div className={cn("rounded-[10px] px-3 py-2.5 text-[0.92rem]", t, className)}>{children}</div>
  );
}

export function PageHeader({
  title,
  lede,
  actions,
}: {
  title: string;
  lede?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
      <div className="min-w-0">
        <h1>{title}</h1>
        {lede ? <p className="mt-1.5 max-w-[64ch] text-muted-foreground">{lede}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2.5 rounded-[14px] border border-dashed border-border bg-card px-5 py-7">
      <h2 className="text-[1.05rem]">{title}</h2>
      {children ? <div className="max-w-[60ch] text-muted-foreground">{children}</div> : null}
      {action}
    </div>
  );
}

export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn("label-caps", className)}>{children}</span>;
}
