"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  BookOpen,
  Home,
  Inbox,
  LogOut,
  Mail,
  MessagesSquare,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavCounts } from "@/lib/shell";

type Item = {
  href: string;
  label: string;
  icon: React.ElementType;
  count?: keyof NavCounts;
  show: boolean;
};

export function Rail({
  name,
  roleLabel,
  counts,
  access,
  signOut,
}: {
  name: string;
  roleLabel: string;
  counts: NavCounts;
  access: { bots: boolean; knowledge: boolean; reports: boolean; settings: boolean };
  signOut: () => Promise<void>;
}) {
  const path = usePathname();
  const items: Item[] = [
    { href: "/", label: "Home", icon: Home, show: true },
    {
      href: "/knowledge",
      label: "Knowledge",
      icon: BookOpen,
      count: "gaps",
      show: access.knowledge,
    },
    { href: "/inbox", label: "Inbox", icon: Inbox, count: "inbox", show: true },
    { href: "/emails", label: "Emails", icon: Mail, count: "emails", show: true },
    { href: "/try", label: "Try a bot", icon: MessagesSquare, show: access.bots },
    { href: "/reports", label: "Reports", icon: BarChart3, show: access.reports },
    { href: "/settings", label: "Settings", icon: Settings, show: access.settings },
  ];
  const active = (href: string) =>
    href === "/" ? path === "/" || path.startsWith("/bots") : path.startsWith(href);

  return (
    <nav
      aria-label="Main"
      className="flex flex-col gap-3 rounded-[14px] border border-border bg-card p-2.5 lg:sticky lg:top-[calc(16px+env(safe-area-inset-top))] lg:max-h-[calc(100dvh-32px)] lg:gap-3.5 lg:self-start lg:overflow-auto lg:px-3 lg:py-4.5"
    >
      <Link href="/" className="flex items-center gap-2.5 px-2 pt-1 lg:pt-0">
        <span className="brand-mark" aria-hidden />
        <span className="brand-word">Billie</span>
      </Link>
      <p className="hidden px-2 text-[0.8rem] text-muted-foreground lg:block">
        Chat and inbox assistant for Media10 shows
      </p>
      <ul className="flex gap-1 overflow-x-auto pb-0.5 lg:flex-col lg:gap-0.5 lg:overflow-visible">
        {items
          .filter((i) => i.show)
          .map((i) => {
            const n = i.count ? counts[i.count] : 0;
            const on = active(i.href);
            return (
              <li key={i.href}>
                <Link
                  href={i.href}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 whitespace-nowrap rounded-[9px] px-2.5 py-2 font-semibold hover:bg-muted",
                    on && "bg-accent hover:bg-accent",
                  )}
                >
                  <i.icon
                    className={cn(
                      "size-[18px] shrink-0 text-muted-foreground",
                      on && "text-primary",
                    )}
                    aria-hidden
                  />
                  {i.label}
                  {n > 0 ? (
                    <span
                      className="ml-auto grid h-5 min-w-[22px] place-items-center rounded-full bg-signal px-1.5 text-[0.74rem] font-extrabold text-signal-foreground tabular-nums"
                      aria-label={`${n} waiting`}
                    >
                      {n}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
      </ul>
      <div className="hidden flex-col gap-2 border-t border-border px-2 pt-3 lg:mt-auto lg:flex">
        <div className="min-w-0">
          <p className="truncate font-semibold">{name}</p>
          <p className="text-sm text-muted-foreground">{roleLabel}</p>
        </div>
        <form action={signOut}>
          <button
            type="submit"
            className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            <LogOut className="size-4" aria-hidden /> Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
