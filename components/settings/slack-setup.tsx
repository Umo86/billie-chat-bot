"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Hash, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { CopyButton } from "@/components/ui/copy-button";
import { useRunner } from "@/components/ui/use-runner";
import { saveSlackChannelAction, testSlackChannelAction } from "@/app/actions/slack";

type Channel = { id: string; name: string; private: boolean };
export type SlackScreen =
  | { connected: false }
  | { connected: true; team: string; channels: Channel[]; problem: string | null };

/**
 * Choosing the Slack channel Billie posts to: a bot's own (its Email step),
 * or the company-wide one for bots without (Settings → Connections). Only
 * channels Billie has been added to are listed.
 */
export function SlackChannelPicker({
  botId,
  slack,
  channelId,
  canManage,
  fallback,
}: {
  botId: string | null;
  slack: Extract<SlackScreen, { connected: true }>;
  channelId: string | null;
  canManage: boolean;
  /** Where posts go with no channel chosen (the company-wide one's name), if anywhere. */
  fallback?: string | null;
}) {
  const router = useRouter();
  const { pending, run } = useRunner();
  const [chosen, setChosen] = useState(channelId ?? "");
  const current = slack.channels.find((c) => c.id === channelId);
  const label = (c: Channel) => `#${c.name}${c.private ? " (private)" : ""}`;
  return (
    <div className="flex flex-col gap-3" data-testid="slack-channel">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        {current ? (
          <>
            <Chip tone="good">Posting</Chip> in {label(current)}.
          </>
        ) : channelId ? (
          <>
            <Chip tone="warn">Check</Chip> The channel chosen before isn&apos;t one Billie is in
            now. Add Billie to it in Slack, or choose another.
          </>
        ) : fallback ? (
          <>
            <Chip>Company-wide</Chip> No channel of its own: posts go to #{fallback}.
          </>
        ) : (
          <>
            <Chip tone="warn">Not yet</Chip> Choose the channel the team watches for this.
          </>
        )}
      </p>
      {canManage ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => saveSlackChannelAction({ botId, channelId: chosen }), {
              done: () => router.refresh(),
            });
          }}
        >
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-semibold">
            Slack channel
            <select
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              className="min-h-[38px] min-w-[220px] max-w-full rounded-[9px] border border-input bg-card px-3 py-2 text-[0.95rem] font-normal"
            >
              <option value="">{botId ? "None (use the company-wide one)" : "None"}</option>
              {slack.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {label(c)}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || chosen === (channelId ?? "")}
          >
            Save channel
          </Button>
          {current || (!channelId && fallback) ? (
            <Button
              type="button"
              disabled={pending}
              onClick={() => run(() => testSlackChannelAction({ botId }))}
            >
              <Send /> Send a test post
            </Button>
          ) : null}
        </form>
      ) : null}
      {canManage && !slack.channels.length ? (
        <Note tone="warn">
          Billie isn&apos;t in any channel yet. In Slack, open the channel and type{" "}
          <code>/invite @Billie</code>, then reload this page.
        </Note>
      ) : null}
    </div>
  );
}

/**
 * Settings → Connections: Slack for the team. Not connected, it says how,
 * with the app's manifest to paste; connected, which workspace, and the
 * company-wide channel.
 */
export function SlackSetup({
  slack,
  manifest,
  channelId,
}: {
  slack: SlackScreen;
  manifest: string;
  channelId: string | null;
}) {
  return (
    <Panel className="flex flex-col gap-4" data-testid="slack-setup">
      <div className="flex items-start gap-3">
        <Hash className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-[1.05rem]">Slack</h2>
          <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
            The team works in Slack. A chat that needs a person is posted in the event&apos;s
            channel with what was said so far, and the team answers in its thread: each reply goes
            to the visitor. Email replies to check, the weekly and show-day posts and requests go
            there too. Once Slack is connected, Billie stops posting to Teams.
          </p>
        </div>
      </div>
      {slack.connected ? (
        slack.problem ? (
          <Note tone="bad">{slack.problem}</Note>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="slack-status">
              <Chip tone="good">Connected</Chip> to {slack.team || "your workspace"}. Choose each
              bot&apos;s channel on its Email step.
            </p>
            <div>
              <h3 className="text-[0.95rem] font-semibold">Company-wide channel</h3>
              <p className="mb-2 text-sm text-muted-foreground">
                For chats from bots without a channel of their own.
              </p>
              <SlackChannelPicker botId={null} slack={slack} channelId={channelId} canManage />
            </div>
          </>
        )
      ) : (
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
          <li>
            In Slack, go to <strong>api.slack.com/apps</strong> → <strong>Create New App</strong> →{" "}
            <strong>From a manifest</strong>, choose your workspace, and paste this:
            <pre
              id="slack-manifest"
              className="mt-2 max-h-72 overflow-auto rounded-[8px] bg-muted px-3 py-2 text-[0.78rem]"
            >
              {manifest}
            </pre>
            <div className="mt-2">
              <CopyButton text={manifest} label="Copy the manifest" selectId="slack-manifest" />
            </div>
          </li>
          <li>
            Choose <strong>Install to Workspace</strong>, and allow it.
          </li>
          <li>
            In Vercel → Settings → Environment Variables, add <code>SLACK_BOT_TOKEN</code> (OAuth
            &amp; Permissions → Bot User OAuth Token, starting <code>xoxb-</code>) and{" "}
            <code>SLACK_SIGNING_SECRET</code> (Basic Information → Signing Secret). Then redeploy.
          </li>
          <li>
            In each event&apos;s Slack channel, type <code>/invite @Billie</code>. Then choose the
            channel on the bot&apos;s Email step.
          </li>
          <li>
            Everyone who answers in Slack needs to be on Billie with the same email as their Slack
            account.
          </li>
        </ol>
      )}
    </Panel>
  );
}
