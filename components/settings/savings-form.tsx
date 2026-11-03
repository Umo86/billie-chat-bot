"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Panel } from "@/components/ui/bits";
import { Switch } from "@/components/ui/switch";
import { useRunner } from "@/components/ui/use-runner";
import { saveSavingsAction } from "@/app/actions/settings";

type Key = "tryFastFirst" | "reuseAnswers";

const ITEMS: { key: Key; title: string; text: string }[] = [
  {
    key: "tryFastFirst",
    title: "Try the Fast model first",
    text: "Thorough bots answer with the Fast model, and ask the Thorough model only when the Fast one isn't sure, or is busy. Most questions cost a twentieth as much. Suggested replies work the same way. Email drafts always use the Thorough model.",
  },
  {
    key: "reuseAnswers",
    title: "Give the same answer again",
    text: "When someone asks a bot the same first question as someone else that day, and nothing in its knowledge has changed, Billie gives the same answer without asking Claude: no tokens at all. Not in tests, not for signed-in exhibitors, not for questions with an email address or phone number. Marking an answer unhelpful stops it being given again.",
  },
];

/** Settings → AI: the ways Billie keeps Claude's tokens down, each a switch. */
export function SavingsForm({ initial }: { initial: Record<Key, boolean> }) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const save = useRunner();

  return (
    <Panel className="flex flex-col gap-3" data-testid="ai-savings">
      <div>
        <h2 className="text-[1.05rem]">Saving tokens</h2>
        <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
          Billie already sends only the passages that matter, keeps the bot&apos;s knowledge in
          Claude&apos;s cache between questions, sends only the last few messages of a chat, and
          asks for short answers.
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {ITEMS.map((item) => (
          <li key={item.key} className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <label htmlFor={`saving-${item.key}`} className="font-semibold">
                {item.title}
              </label>
              <p className="max-w-[68ch] text-sm text-muted-foreground">{item.text}</p>
            </div>
            <Switch
              id={`saving-${item.key}`}
              checked={on[item.key]}
              disabled={save.pending}
              onCheckedChange={(v) =>
                save.run(() => saveSavingsAction({ [item.key]: v }), {
                  done: () => {
                    setOn((o) => ({ ...o, [item.key]: v }));
                    router.refresh();
                  },
                })
              }
            />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
