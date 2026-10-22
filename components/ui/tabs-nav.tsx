import Link from "next/link";
import { cn } from "@/lib/utils";

/** Page-level tabs as links, so each tab has its own address. */
export function TabsNav({
  label,
  tabs,
  current,
}: {
  label: string;
  tabs: { key: string; href: string; label: React.ReactNode }[];
  current: string;
}) {
  return (
    <nav
      aria-label={label}
      className="inline-flex max-w-full flex-wrap gap-1 self-start rounded-[10px] bg-muted p-1"
    >
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={cn(
            "rounded-[7px] px-3 py-1.5 text-[0.92rem] font-semibold text-muted-foreground hover:text-foreground",
            t.key === current && "bg-card text-foreground shadow-sm",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
