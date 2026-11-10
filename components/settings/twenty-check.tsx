"use client";

import { PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/bits";
import { useRunner } from "@/components/ui/use-runner";
import { checkTwentyAction } from "@/app/actions/settings";

/** Settings → Connections: checks the Twenty key works before the first lead needs it. */
export function TwentyCheck() {
  const { pending, run } = useRunner();
  return (
    <Panel className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-[1.05rem]">Twenty CRM</h2>
        <p className="text-sm text-muted-foreground">
          Leads go to Twenty as soon as they&apos;re sent. Check the connection works before the
          first one does: Billie only reads one record, and changes nothing.
        </p>
      </div>
      <Button disabled={pending} onClick={() => run(() => checkTwentyAction())}>
        <PlugZap /> Test the connection
      </Button>
    </Panel>
  );
}
