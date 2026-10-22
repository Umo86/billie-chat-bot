"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/actions/result";

/**
 * Calls a server action inside a transition and turns its result into a
 * toast: errors always show; success shows the action's own message.
 */
export function useRunner() {
  const [pending, start] = useTransition();
  function run<T>(
    fn: () => Promise<ActionResult<T>>,
    opts: { done?: (data: T | undefined) => void; failed?: (r: ActionResult<T>) => void } = {},
  ) {
    start(async () => {
      let r: ActionResult<T>;
      try {
        r = await fn();
      } catch {
        toast.error("Couldn't reach Billie. Check your connection and try again.");
        return;
      }
      if (!r.ok) {
        toast.error(r.error);
        opts.failed?.(r);
        return;
      }
      if (r.message) toast.success(r.message);
      opts.done?.(r.data);
    });
  }
  return { pending, run };
}
