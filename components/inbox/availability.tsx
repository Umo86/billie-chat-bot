"use client";

import { Switch } from "@/components/ui/switch";
import { useRunner } from "@/components/ui/use-runner";
import { setAvailabilityAction } from "@/app/actions/inbox";

/**
 * Who gets a Teams message when a live chat needs a person (with Teams
 * messages to people set up, and Slack not connected). Whether a chat goes
 * live is the bot's working hours, not this.
 */
export function Availability({ available, others }: { available: boolean; others: number }) {
  const { pending, run } = useRunner();
  return (
    <label className="flex items-center gap-3 rounded-[12px] border border-border bg-card px-3.5 py-2.5">
      <Switch
        checked={available}
        disabled={pending}
        onCheckedChange={(v) => run(() => setAvailabilityAction({ available: v }))}
        aria-label="Teams messages for live chats"
      />
      <span className="min-w-0">
        <span className="block font-semibold">
          {available ? "You get live chats in Teams" : "Live chats aren't sent to you"}
        </span>
        <span className="block text-sm text-muted-foreground">
          {available
            ? "A Teams message when a live chat needs a person. Stays on for 8 hours while this page is open."
            : others
              ? `${others} ${others === 1 ? "colleague gets" : "colleagues get"} them now.`
              : "Turn on to get a Teams message when a live chat needs a person."}
        </span>
      </span>
    </label>
  );
}
