"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/form";

/**
 * One bot's Inbox, requests or emails, or all of them. Shown when someone
 * works on more than one bot; the choice goes in the address (?bot=).
 */
export function BotFilter({
  bots,
  current,
  path,
  keep = {},
  everyBot,
}: {
  bots: { id: string; name: string }[];
  current: string | null;
  path: string;
  /** Other parts of the address to keep, such as the tab. */
  keep?: Record<string, string>;
  /** Admins see every bot; others see the bots they work on. */
  everyBot: boolean;
}) {
  const router = useRouter();
  if (bots.length < 2) return null;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="bot-filter" className="text-sm font-semibold text-muted-foreground">
        Bot
      </label>
      <Select
        id="bot-filter"
        className="w-auto min-w-48"
        value={current ?? ""}
        onChange={(e) => {
          const params = new URLSearchParams(keep);
          if (e.target.value) params.set("bot", e.target.value);
          const q = params.toString();
          router.push(q ? `${path}?${q}` : path);
        }}
      >
        <option value="">{everyBot ? "All bots" : "All my bots"}</option>
        {bots.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
