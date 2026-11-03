"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Inbox, MessagesSquare, PlugZap, Send, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Field, Input, Select } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { useRunner } from "@/components/ui/use-runner";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { startHistoryAction } from "@/app/actions/knowledge";
import {
  checkBotMailboxAction,
  removeBotMailboxAction,
  removeBotTeamsAction,
  saveBotMailboxAction,
  saveBotTeamsAction,
  testBotTeamsAction,
} from "@/app/actions/bot-email";

type Mailbox = { address: string; assignedUserId: string | null; enabled: boolean };

/**
 * The bot's event mailbox and Teams channel. New emails in the mailbox get
 * a reply from this bot's knowledge, saved in the mailbox's Drafts, and a
 * post in the event's Teams channel that @mentions whoever manages it.
 * Admins change it; everyone else sees how it is set up.
 */
export function EmailStep({
  botId,
  botName,
  mailbox,
  status,
  teams,
  managers,
  microsoft,
  companyTeams,
  canManage,
  history = null,
  canLearn = false,
}: {
  botId: string;
  botName: string;
  mailbox: Mailbox | null;
  /** How the last sync went, in words (worked out on the server). */
  status: { tone: "good" | "bad" | "neutral"; text: string } | null;
  /** The saved Teams link's host, never the link itself. */
  teams: string | null;
  managers: { id: string; name: string; email: string }[];
  microsoft: boolean;
  companyTeams: boolean;
  canManage: boolean;
  /** Learning from the mailbox's past emails: how the last read went. */
  history?: {
    status: "reading" | "done" | "failed" | null;
    note: string | null;
    at: string | null;
    waiting: number;
  } | null;
  canLearn?: boolean;
}) {
  const router = useRouter();
  const { pending, run } = useRunner();
  const [box, setBox] = useState<Mailbox>(
    mailbox ?? { address: "", assignedUserId: null, enabled: true },
  );
  const [link, setLink] = useState("");
  const [replacing, setReplacing] = useState(!teams);
  const [confirm, setConfirm] = useState<"mailbox" | "teams" | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const manager = managers.find((m) => m.id === (mailbox?.assignedUserId ?? ""));

  const failed = (r: { ok: boolean; fieldErrors?: Record<string, string> }) =>
    !r.ok && setErrors(r.fieldErrors ?? {});

  function saveMailbox(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    run(() => saveBotMailboxAction({ botId, ...box }), {
      failed,
      done: () => router.refresh(),
    });
  }

  function saveTeams(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    run(() => saveBotTeamsAction({ botId, link }), {
      failed,
      done: () => {
        setLink("");
        setReplacing(false);
        router.refresh();
      },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Inbox className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <h2 className="text-[1.05rem]">Event mailbox</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              When an email arrives in this mailbox, {botName} writes a reply from its knowledge and
              leaves it in the mailbox&apos;s Drafts folder, in the same thread. Nothing is sent
              until someone checks it and sends it from Outlook.
            </p>
          </div>
        </div>

        {!microsoft ? (
          <Note tone="warn">
            Microsoft 365 isn&apos;t connected yet. An admin connects it once for the whole company
            (Settings → Connections). You can save the mailbox now; Billie starts reading it once
            Microsoft 365 is connected.
          </Note>
        ) : null}

        {mailbox && status ? (
          <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="mailbox-status">
            <Chip tone={status.tone}>
              {!mailbox.enabled
                ? "Off"
                : status.tone === "bad"
                  ? "Problem"
                  : status.tone === "good"
                    ? "Working"
                    : "Waiting"}
            </Chip>
            <span className={status.tone === "bad" ? "text-bad" : "text-muted-foreground"}>
              {status.text}
            </span>
          </p>
        ) : null}

        {canManage ? (
          <form onSubmit={saveMailbox} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                id="mailbox-address"
                label="Mailbox address"
                hint="A shared mailbox in Microsoft 365, for this event."
                error={errors.address}
              >
                <Input
                  id="mailbox-address"
                  type="email"
                  autoComplete="off"
                  value={box.address}
                  placeholder="ukcw-exhibitors@media-ten.com"
                  aria-invalid={Boolean(errors.address)}
                  onChange={(e) => setBox((b) => ({ ...b, address: e.target.value }))}
                />
              </Field>
              <Field
                id="mailbox-manager"
                label="Managed by"
                hint="They get a Teams message for each new email (once Teams messages are set up in Settings), and an @mention in the channel post. Their Billie email must be their Microsoft 365 address."
                error={errors.assignedUserId}
              >
                <Select
                  id="mailbox-manager"
                  value={box.assignedUserId ?? ""}
                  onChange={(e) =>
                    setBox((b) => ({ ...b, assignedUserId: e.target.value || null }))
                  }
                >
                  <option value="">Nobody yet</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.email})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <label className="flex items-center gap-3">
              <Switch
                checked={box.enabled}
                onCheckedChange={(x) => setBox((b) => ({ ...b, enabled: x }))}
                aria-label="Billie reads this mailbox"
              />
              <span>Billie reads this mailbox</span>
            </label>
            <p className="text-sm text-muted-foreground">
              Billie drafts replies to emails that arrive once it starts reading (and again from
              when it&apos;s switched back on), not older mail. Auto-replies, bounces and meeting
              replies are skipped. Everyone on the Billie team can see the emails Billie reads, on
              the Emails page.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={pending}>
                Save mailbox
              </Button>
              {mailbox ? (
                <>
                  <Button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => checkBotMailboxAction({ botId }))}
                  >
                    <PlugZap /> Check the mailbox
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setConfirm("mailbox")}
                  >
                    <Unplug /> Disconnect
                  </Button>
                </>
              ) : null}
            </div>
            {confirm === "mailbox" && mailbox ? (
              <Note tone="warn">
                <span className="flex flex-col gap-2">
                  <span>
                    Disconnect {mailbox.address}? Billie stops reading it. Emails already in Billie
                    stay.
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={pending}
                      onClick={() =>
                        run(() => removeBotMailboxAction({ botId }), {
                          done: () => {
                            setConfirm(null);
                            setBox({ address: "", assignedUserId: null, enabled: true });
                            router.refresh();
                          },
                        })
                      }
                    >
                      Yes, disconnect
                    </Button>
                    <Button type="button" size="sm" onClick={() => setConfirm(null)}>
                      Keep it
                    </Button>
                  </span>
                </span>
              </Note>
            ) : null}
          </form>
        ) : (
          <div className="flex flex-col gap-1 text-sm">
            <p>
              <strong>Mailbox:</strong> {mailbox ? mailbox.address : "none yet"}
            </p>
            {mailbox ? (
              <p>
                <strong>Managed by:</strong> {manager ? manager.name : "nobody yet"}
              </p>
            ) : null}
            <Note>Only admins can change the mailbox and the Teams channel.</Note>
          </div>
        )}
      </Panel>

      {mailbox && microsoft ? (
        <PastEmails botId={botId} history={history} canLearn={canLearn} />
      ) : null}

      <Panel className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <MessagesSquare className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <h2 className="text-[1.05rem]">Teams channel</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Billie posts in the event&apos;s channel when a reply is waiting in Drafts, or an
              email needs a person, and @mentions whoever manages the mailbox. Chats with {botName}{" "}
              that need a person are posted there too.
            </p>
          </div>
        </div>

        {teams ? (
          <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="teams-status">
            <Chip tone="good">Saved</Chip>
            <span className="text-muted-foreground">Posts go through {teams}.</span>
          </p>
        ) : companyTeams ? (
          <p className="text-sm text-muted-foreground">
            No channel for this bot yet, so chats that need a person go to the company-wide Teams
            channel. Email posts need the event&apos;s own channel.
          </p>
        ) : null}

        {canManage ? (
          <>
            {teams && !replacing ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => testBotTeamsAction({ botId }))}
                >
                  <Send /> Send a test post
                </Button>
                <Button type="button" disabled={pending} onClick={() => setReplacing(true)}>
                  Replace the link
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setConfirm("teams")}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <form onSubmit={saveTeams} className="flex flex-col gap-3">
                <Field
                  id="teams-link"
                  label="Teams Workflows link"
                  hint={
                    <>
                      In Teams, open the event&apos;s channel and choose ••• → Workflows →
                      &ldquo;Post to a channel when a webhook request is received&rdquo;. Follow the
                      steps, then copy the link it gives you. Treat it like a password: it
                      won&apos;t be shown again.
                    </>
                  }
                  error={errors.link}
                >
                  <Input
                    id="teams-link"
                    type="url"
                    autoComplete="off"
                    value={link}
                    placeholder="https://…"
                    aria-invalid={Boolean(errors.link)}
                    onChange={(e) => setLink(e.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" variant="primary" disabled={pending || !link.trim()}>
                    Save link
                  </Button>
                  {teams ? (
                    <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </form>
            )}
            {confirm === "teams" ? (
              <Note tone="warn">
                <span className="flex flex-col gap-2">
                  <span>Remove the Teams channel? Billie stops posting there.</span>
                  <span className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={pending}
                      onClick={() =>
                        run(() => removeBotTeamsAction({ botId }), {
                          done: () => {
                            setConfirm(null);
                            setReplacing(true);
                            router.refresh();
                          },
                        })
                      }
                    >
                      Yes, remove
                    </Button>
                    <Button type="button" size="sm" onClick={() => setConfirm(null)}>
                      Keep it
                    </Button>
                  </span>
                </span>
              </Note>
            ) : null}
          </>
        ) : null}
      </Panel>

      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="primary">
          <Link href={`/bots/${botId}?step=test`}>Continue to Test</Link>
        </Button>
        <p className="text-sm text-muted-foreground">
          You can come back to this any time. The mailbox works whether or not the chat is live.
        </p>
      </div>
    </div>
  );
}

/**
 * Learning from the mailbox's past emails: Billie reads the team's replies
 * and finds the questions people asked most, for the Knowledge page.
 */
function PastEmails({
  botId,
  history,
  canLearn,
}: {
  botId: string;
  history: {
    status: "reading" | "done" | "failed" | null;
    note: string | null;
    at: string | null;
    waiting: number;
  } | null;
  canLearn: boolean;
}) {
  const router = useRouter();
  const [months, setMonths] = useState("12");
  const { pending, run } = useRunner();
  const reading = history?.status === "reading";
  return (
    <Panel className="flex flex-col gap-3" data-testid="past-emails">
      <AutoRefresh active={reading} every={5000} />
      <div>
        <h2 className="text-[1.05rem]">Learn from past emails</h2>
        <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
          Billie reads the replies the team sent from this mailbox, with the emails they answered,
          and finds the questions people asked most. Each comes to the Knowledge page (To improve)
          with the team&apos;s answer, for you to check and save. Nothing in the mailbox changes,
          and the emails themselves aren&apos;t kept.
        </p>
      </div>
      {reading ? (
        <Note>Reading the past emails… This takes a few minutes.</Note>
      ) : history?.status === "failed" ? (
        <Note tone="bad">{history.note}</Note>
      ) : history?.status === "done" ? (
        <Note tone="good">
          {history.note}
          {history.waiting ? (
            <>
              {" "}
              <Link href="/knowledge?tab=gaps" className="font-semibold text-primary">
                Check them
              </Link>
            </>
          ) : null}
        </Note>
      ) : null}
      {canLearn ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field id="history-months" label="How far back">
            <Select
              id="history-months"
              value={months}
              onChange={(e) => setMonths(e.target.value)}
              disabled={pending || reading}
            >
              <option value="3">The past 3 months</option>
              <option value="6">The past 6 months</option>
              <option value="12">The past year</option>
            </Select>
          </Field>
          <Button
            variant="primary"
            disabled={pending || reading}
            onClick={() =>
              run(() => startHistoryAction({ botId, months: Number(months) }), {
                done: () => router.refresh(),
              })
            }
          >
            <Inbox /> Find the common questions
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
