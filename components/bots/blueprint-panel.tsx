"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { CopyButton } from "@/components/ui/copy-button";
import { useRunner } from "@/components/ui/use-runner";
import { makeBlueprintKeyAction, removeBlueprintKeyAction } from "@/app/actions/exhibitors";

type Linked = {
  /** "3 days ago by Umit Bozdag" */
  made: string;
  /** "5 minutes ago", or null if BluePrint hasn't sent the list yet. */
  lastSync: string | null;
  lastSignIn: string | null;
};

const GUIDE = "https://github.com/Umo86/billie-chat-bot/blob/main/docs/blueprint.md";

/**
 * BluePrint, the exhibitor manual, on an exhibitor bot's Exhibitors step:
 * exhibitors signed in to the manual are signed in to the chat, and the
 * manual can keep the exhibitor list up to date. Admins connect it: Billie
 * makes a key and shows it once.
 */
export function BlueprintPanel({
  botId,
  slug,
  appUrl,
  linked,
  canManage,
  personalAnswers,
}: {
  botId: string;
  slug: string;
  appUrl: string;
  linked: Linked | null;
  canManage: boolean;
  personalAnswers: boolean;
}) {
  const router = useRouter();
  const [key, setKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"new" | "remove" | null>(null);
  const make = useRunner();
  const remove = useRunner();

  function makeKey() {
    make.run(() => makeBlueprintKeyAction({ botId }), {
      done: (d) => {
        if (d?.key) setKey(d.key);
        setConfirm(null);
        router.refresh();
      },
    });
  }

  const snippet = `<script src="${appUrl}/widget.js" data-bot="${slug}" data-exhibitor-token="SIGN-IN FROM BLUEPRINT" async></script>`;

  return (
    <Panel className="flex flex-col gap-3" data-testid="blueprint">
      <div>
        <h2 className="text-[1.05rem]">BluePrint, the exhibitor manual</h2>
        <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
          Connect BluePrint, and exhibitors signed in to the manual are signed in to the chat too,
          with no code to type. BluePrint can also keep this exhibitor list up to date, so the
          deadline chasers see what each exhibitor has sent.
        </p>
      </div>

      {key ? (
        <Note tone="warn">
          <div className="flex flex-col gap-2">
            <p>
              <strong>Copy this key into the show&apos;s settings in BluePrint now.</strong> You
              won&apos;t see it again: Billie keeps only what it needs to check it.
            </p>
            <code
              id="blueprint-key"
              className="break-all rounded-[8px] border border-border bg-card px-3 py-2 font-mono text-[0.82rem]"
            >
              {key}
            </code>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={key} label="Copy key" selectId="blueprint-key" />
              <Button size="sm" onClick={() => setKey(null)}>
                I&apos;ve copied it
              </Button>
            </div>
          </div>
        </Note>
      ) : null}

      {linked ? (
        <>
          <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="blueprint-status">
            <Chip tone="good">Connected</Chip> Key made {linked.made}.
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>
              {linked.lastSync
                ? `BluePrint last sent the exhibitor list ${linked.lastSync}.`
                : "BluePrint hasn't sent the exhibitor list yet."}
            </li>
            <li>
              {linked.lastSignIn
                ? `An exhibitor last signed in from the manual ${linked.lastSignIn}.`
                : "Nobody has signed in from the manual yet."}
            </li>
          </ul>
          {!personalAnswers ? (
            <Note tone="warn">
              Turn on <strong>Answers about their own stand</strong> above, or Billie won&apos;t
              sign anyone in from the manual.
            </Note>
          ) : null}
        </>
      ) : !canManage ? (
        <Note>Not connected. An admin can connect BluePrint here.</Note>
      ) : null}

      {canManage && !linked ? (
        <div>
          <Button variant="primary" disabled={make.pending} onClick={makeKey}>
            <KeyRound /> Connect BluePrint
          </Button>
        </div>
      ) : null}

      {canManage && linked && !confirm ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setConfirm("new")}>
            <KeyRound /> Make a new key
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm("remove")}>
            <Unplug /> Disconnect
          </Button>
        </div>
      ) : null}
      {confirm === "new" ? (
        <Note tone="warn">
          <p>
            Make a new key? The old one stops working straight away. Put the new key in BluePrint at
            once, or exhibitors won&apos;t be signed in and the list won&apos;t update.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="dangerSolid" disabled={make.pending} onClick={makeKey}>
              Make a new key
            </Button>
            <Button size="sm" onClick={() => setConfirm(null)}>
              Keep the old one
            </Button>
          </div>
        </Note>
      ) : null}
      {confirm === "remove" ? (
        <Note tone="warn">
          <p>
            Disconnect BluePrint? It stops signing exhibitors in and updating the list. The list
            stays as it is.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="dangerSolid"
              disabled={remove.pending}
              onClick={() =>
                remove.run(() => removeBlueprintKeyAction({ botId }), {
                  done: () => {
                    setConfirm(null);
                    setKey(null);
                    router.refresh();
                  },
                })
              }
            >
              Disconnect
            </Button>
            <Button size="sm" onClick={() => setConfirm(null)}>
              Keep it
            </Button>
          </div>
        </Note>
      ) : null}

      <details className="rounded-[10px] border border-border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-semibold">For whoever sets up BluePrint</summary>
        <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5">
          <li>Keep the key with this show&apos;s settings in BluePrint, never in a page.</li>
          <li>
            Whenever the exhibitor list changes (at most once a minute), send the whole list to{" "}
            <code className="break-all">POST {appUrl}/api/public/blueprint/exhibitors</code> with
            the header <code>Authorization: Bearer</code> and the key.
          </li>
          <li>
            On the manual&apos;s pages, add <code>data-exhibitor-token</code> to the chat&apos;s
            script tag, with a sign-in BluePrint makes for the exhibitor:
            <pre className="mt-1 overflow-x-auto rounded-[8px] bg-muted px-3 py-2 text-[0.78rem]">
              {snippet}
            </pre>
          </li>
          <li>
            Add BluePrint&apos;s web address to this bot&apos;s websites, on the Go live step.
          </li>
          <li>
            The full guide has the list&apos;s format and how to make a sign-in:{" "}
            <a href={GUIDE} target="_blank" rel="noreferrer" className="font-semibold text-primary">
              docs/blueprint.md
            </a>
            .
          </li>
        </ol>
      </details>
    </Panel>
  );
}
