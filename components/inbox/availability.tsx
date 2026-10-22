"use client";

import { Switch } from "@/components/ui/switch";
import { useRunner } from "@/components/ui/use-runner";
import { setAvailabilityAction } from "@/app/actions/inbox";

export function Availability({ available, others }: { available: boolean; others: number }) {
  const { pending, run } = useRunner();
  return (
    <label className="flex items-center gap-3 rounded-[12px] border border-border bg-card px-3.5 py-2.5">
      <Switch
        checked={available}
        disabled={pending}
        onCheckedChange={(v) => run(() => setAvailabilityAction({ available: v }))}
        aria-label="Available for live chats"
      />
      <span className="min-w-0">
        <span className="block font-semibold">
          {available ? "You're available for live chats" : "You're not taking live chats"}
        </span>
        <span className="block text-sm text-muted-foreground">
          {available
            ? "Chats that need a person come straight to you. Stays on for 8 hours while this page is open."
            : others
              ? `${others} ${others === 1 ? "colleague is" : "colleagues are"} available.`
              : "Nobody is available, so Billie takes contact details instead."}
        </span>
      </span>
    </label>
  );
}
