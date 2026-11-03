"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquareText, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Field, Input } from "@/components/ui/form";
import { CopyButton } from "@/components/ui/copy-button";
import { useRunner } from "@/components/ui/use-runner";
import {
  removeTeamsDirectAction,
  saveTeamsDirectAction,
  testTeamsDirectAction,
} from "@/app/actions/teams-direct";

const RECIPIENT = "triggerBody()?['recipient']";
const CARD = "triggerBody()?['card']";

/**
 * Teams messages to people: one company-wide workflow that sends a person a
 * Teams chat. Billie uses it for the mailbox manager when a reply is waiting
 * in Drafts, and for whoever is available when a visitor wants a person.
 */
export function TeamsDirect({ saved, me }: { saved: string | null; me: string }) {
  const router = useRouter();
  const { pending, run } = useRunner();
  const [link, setLink] = useState("");
  const [editing, setEditing] = useState(!saved);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    run(() => saveTeamsDirectAction({ link }), {
      failed: (r) => !r.ok && setError(r.fieldErrors?.link ?? null),
      done: () => {
        setLink("");
        setEditing(false);
        router.refresh();
      },
    });
  }

  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <MessageSquareText className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-[1.05rem]">Teams messages to people</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Billie sends a Teams chat to the right person: the mailbox manager when a reply is
            waiting in Drafts, and whoever is available when a visitor wants a person (or the
            mailbox manager, when nobody is). Each message has an &ldquo;Open in Billie&rdquo;
            button. Channel posts carry on as well.
          </p>
        </div>
      </div>

      {saved ? (
        <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="teams-direct-status">
          <Chip tone="good">Saved</Chip>
          <span className="text-muted-foreground">Messages go through {saved}.</span>
        </p>
      ) : null}

      {saved && !editing ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={pending}
            onClick={() => run(() => testTeamsDirectAction({}))}
          >
            <Send /> Send me a test message
          </Button>
          <Button type="button" disabled={pending} onClick={() => setEditing(true)}>
            Replace the link
          </Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirm(true)}>
            Turn off
          </Button>
        </div>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-3">
          <Field
            id="teams-direct-link"
            label="Workflow link"
            hint="The HTTP URL from the workflow's trigger (steps below). Treat it like a password: it won't be shown again."
            error={error}
          >
            <Input
              id="teams-direct-link"
              type="url"
              autoComplete="off"
              value={link}
              placeholder="https://…"
              aria-invalid={Boolean(error)}
              onChange={(e) => setLink(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={pending || !link.trim()}>
              Save link
            </Button>
            {saved ? (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      )}

      {confirm ? (
        <Note tone="warn">
          <span className="flex flex-col gap-2">
            <span>Turn off Teams messages to people? Channel posts carry on.</span>
            <span className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={() =>
                  run(() => removeTeamsDirectAction({}), {
                    done: () => {
                      setConfirm(false);
                      setEditing(true);
                      router.refresh();
                    },
                  })
                }
              >
                Yes, turn off
              </Button>
              <Button type="button" size="sm" onClick={() => setConfirm(false)}>
                Keep them
              </Button>
            </span>
          </span>
        </Note>
      ) : null}

      <details className="rounded-[10px] bg-muted px-3 py-2">
        <summary className="cursor-pointer text-sm font-semibold">
          How IT sets up the workflow (about 10 minutes, once)
        </summary>
        <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5 text-sm">
          <li>
            Sign in to Power Automate with a shared service account, so the workflow keeps working
            when someone leaves. Choose Create → Instant cloud flow → Skip.
          </li>
          <li>
            Add the trigger <strong>When a Teams webhook request is received</strong> (Microsoft
            Teams). Set &ldquo;Who can trigger the flow?&rdquo; to Anyone.
          </li>
          <li>
            Add the action <strong>Post card in a chat or channel</strong> (Microsoft Teams). Post
            as: Flow bot. Post in: Chat with Flow bot.
          </li>
          <li>
            In Recipient, add this as an expression:
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <code id="dm-recipient" className="rounded-md bg-card px-2 py-1 text-xs">
                {RECIPIENT}
              </code>
              <CopyButton text={RECIPIENT} selectId="dm-recipient" />
            </span>
          </li>
          <li>
            In Adaptive Card, add this as an expression:
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <code id="dm-card" className="rounded-md bg-card px-2 py-1 text-xs">
                {CARD}
              </code>
              <CopyButton text={CARD} selectId="dm-card" />
            </span>
          </li>
          <li>
            Save. Copy the HTTP URL the trigger now shows, paste it above, then send yourself a test
            message. It goes to {me}.
          </li>
        </ol>
        <p className="mt-2 text-sm text-muted-foreground">
          Each person&apos;s email in Billie must be their Microsoft 365 address, and the Workflows
          app must be allowed in Teams (it usually is). The Teams connector comes with Microsoft
          365: no extra licence.
        </p>
      </details>
    </Panel>
  );
}
