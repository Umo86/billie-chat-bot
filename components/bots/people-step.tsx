"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Input, Label } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { saveRoutesAction, setBotPeopleAction, setSlackPeopleAction } from "@/app/actions/bots";
import { MAX_ROUTES } from "@/lib/conversations/routes";

type Person = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "editor" | "agent";
  status: "active" | "suspended";
  everyBot: boolean;
  onBot: boolean;
};

const CAN: Record<Person["role"], string> = {
  admin: "Admin: works on every bot",
  editor: "Editor: runs the bot, its knowledge, Inbox, requests and emails",
  agent: "Agent: answers its Inbox, requests and emails",
};

/**
 * Who works on this bot. Admins tick editors and agents; admins work on
 * every bot. Only people on a bot see its chats, requests and emails, and
 * only they get its Teams messages.
 */
export function PeopleStep({
  botId,
  botName,
  people,
  canManage,
  routes,
  canRoute,
  slack,
}: {
  botId: string;
  botName: string;
  people: Person[];
  canManage: boolean;
  /** Who handles what: a topic, its words, and the person it goes to first. */
  routes: { id: string; topic: string; words: string[]; userId: string }[];
  canRoute: boolean;
  /** Who's told in Slack, once Slack is connected; whether each person was found there. */
  slack: { chosen: string[]; found: Record<string, "found" | "missing" | "unknown"> } | null;
}) {
  const router = useRouter();
  const [on, setOn] = useState<string[]>(
    people.filter((p) => p.onBot && !p.everyBot).map((p) => p.id),
  );
  const { pending, run } = useRunner();
  const admins = people.filter((p) => p.everyBot && p.status === "active");
  const others = people.filter((p) => !p.everyBot && (p.status === "active" || p.onBot));

  function save() {
    run(() => setBotPeopleAction({ botId, userIds: on }), {
      done: () => router.refresh(),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-3" data-testid="people-step">
        <div>
          <h2 className="text-[1.05rem]">Who works on {botName}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Only the people here see this bot&apos;s chats, requests and emails, and get its Teams
            messages. Editors can also change the bot and its knowledge, and put it live.
          </p>
        </div>
        {!canManage ? <Note>Only admins choose who works on a bot.</Note> : null}
        <ul className="flex flex-col gap-2" aria-label="People on the team">
          {others.map((p) => {
            const ticked = on.includes(p.id);
            return (
              <li key={p.id}>
                <label className="flex cursor-pointer items-start gap-3 rounded-[12px] border border-border px-3.5 py-3 has-[:checked]:border-primary has-[:checked]:bg-accent">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-[var(--color-primary)]"
                    checked={ticked}
                    disabled={!canManage}
                    aria-labelledby={`person-${p.id}-name`}
                    aria-describedby={`person-${p.id}-role`}
                    onChange={() =>
                      setOn((list) => (ticked ? list.filter((x) => x !== p.id) : [...list, p.id]))
                    }
                  />
                  <span className="min-w-0">
                    <span id={`person-${p.id}-name`} className="block font-semibold">
                      {p.name || p.email}
                      {p.status === "suspended" ? (
                        <Chip className="ml-2 h-5 text-[0.7rem]">Suspended</Chip>
                      ) : null}
                    </span>
                    <span
                      id={`person-${p.id}-role`}
                      className="block text-sm break-words text-muted-foreground"
                    >
                      {p.email} · {CAN[p.role]}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {!others.length ? (
          <p className="text-sm text-muted-foreground">
            No editors or agents yet. Invite them in{" "}
            <Link href="/settings?tab=team" className="font-semibold text-primary">
              Settings → Team
            </Link>
            .
          </p>
        ) : null}
        {admins.length ? (
          <p className="text-sm text-muted-foreground">
            Always on it, as admins: {admins.map((a) => a.name || a.email).join(", ")}.
          </p>
        ) : null}
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={save} disabled={pending}>
              Save people
            </Button>
          </div>
        ) : null}
      </Panel>
      <SlackPeople
        botId={botId}
        botName={botName}
        people={people.filter((p) => p.status === "active" && (p.everyBot || p.onBot))}
        slack={slack}
        canManage={canManage}
      />
      <Routes
        botId={botId}
        initial={routes}
        people={people.filter((p) => p.status === "active" && (p.everyBot || p.onBot))}
        canEdit={canRoute}
      />
      <div>
        <Button asChild>
          <Link href={`/bots/${botId}?step=email`}>Continue to Email</Link>
        </Button>
      </div>
    </div>
  );
}

type Rule = { id: string; topic: string; words: string; userId: string };

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

/**
 * Who handles what: chats passed to the team, and emails that need a
 * person, go first to whoever handles their topic.
 */
function Routes({
  botId,
  initial,
  people,
  canEdit,
}: {
  botId: string;
  initial: { id: string; topic: string; words: string[]; userId: string }[];
  people: Person[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<Rule[]>(
    initial.map((r) => ({ ...r, words: r.words.join(", ") })),
  );
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = useRunner();
  const update = (id: string, next: Partial<Rule>) =>
    setRules((list) => list.map((r) => (r.id === id ? { ...r, ...next } : r)));

  return (
    <Panel className="flex flex-col gap-3" data-testid="routes">
      <div>
        <h2 className="text-[1.05rem]">Who handles what</h2>
        <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
          A chat passed to the team, or an email that needs a person, goes first to whoever handles
          its topic: they get the Teams message (and the chat, if nobody has it), then whoever is
          available. Billie looks for the words in what the person wrote, so &ldquo;electric&rdquo;
          also finds &ldquo;electrics&rdquo;.
        </p>
      </div>
      {rules.length ? (
        <ul className="flex flex-col gap-3" aria-label="Who handles what">
          {rules.map((r, i) => (
            <li
              key={r.id}
              className="grid grid-cols-1 items-end gap-2 rounded-[12px] border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1.2fr)_auto]"
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`route-${r.id}-topic`}>Topic</Label>
                <Input
                  id={`route-${r.id}-topic`}
                  value={r.topic}
                  maxLength={60}
                  placeholder="Electrics"
                  disabled={!canEdit}
                  onChange={(e) => update(r.id, { topic: e.target.value })}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`route-${r.id}-words`}>Words that mean it</Label>
                <Input
                  id={`route-${r.id}-words`}
                  value={r.words}
                  maxLength={600}
                  placeholder="electric, power, socket"
                  disabled={!canEdit}
                  onChange={(e) => update(r.id, { words: e.target.value })}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`route-${r.id}-person`}>Goes to</Label>
                <select
                  id={`route-${r.id}-person`}
                  className="h-10 rounded-[10px] border border-input bg-card px-3"
                  value={r.userId}
                  disabled={!canEdit}
                  onChange={(e) => update(r.id, { userId: e.target.value })}
                >
                  <option value="">Choose someone</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.email}
                    </option>
                  ))}
                </select>
              </div>
              {canEdit ? (
                <Button
                  variant="ghost"
                  aria-label={`Remove topic ${i + 1}`}
                  onClick={() => setRules((list) => list.filter((x) => x.id !== r.id))}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing yet: everything goes to whoever is available, or the event mailbox&apos;s manager.
        </p>
      )}
      {error ? <Note tone="bad">{error}</Note> : null}
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          {rules.length < MAX_ROUTES ? (
            <Button
              onClick={() =>
                setRules((list) => [...list, { id: newId(), topic: "", words: "", userId: "" }])
              }
            >
              <Plus /> Add a topic
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => {
              setError(null);
              run(() => saveRoutesAction({ botId, routes: rules }), {
                failed: (r) => {
                  if (r.ok || !r.fieldErrors) return;
                  const [key, message] = Object.entries(r.fieldErrors)[0] ?? [];
                  const n = Number(key?.split(".")[1]);
                  if (message) setError(Number.isNaN(n) ? message : `Topic ${n + 1}: ${message}`);
                },
                done: () => router.refresh(),
              });
            }}
          >
            Save who handles what
          </Button>
        </div>
      ) : (
        <Note>Only people who can change the bot set who handles what.</Note>
      )}
    </Panel>
  );
}

const FOUND = {
  found: { tone: "good", text: "In Slack" },
  missing: { tone: "warn", text: "Not found in Slack under this email" },
  unknown: { tone: "neutral", text: "Couldn't check Slack" },
} as const;

/**
 * Who's told in Slack about this bot: its show's team. Billie @mentions them
 * on its chats that need a person, tickets, email replies to check and
 * requests, in the bot's channel (instead of @here). They're found in Slack
 * by their Billie email, which is also how their replies there are matched.
 */
function SlackPeople({
  botId,
  botName,
  people,
  slack,
  canManage,
}: {
  botId: string;
  botName: string;
  people: Person[];
  slack: { chosen: string[]; found: Record<string, "found" | "missing" | "unknown"> } | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string[]>(slack?.chosen ?? []);
  const { pending, run } = useRunner();
  return (
    <Panel className="flex flex-col gap-3" data-testid="slack-people">
      <div>
        <h2 className="text-[1.05rem]">Who&apos;s told in Slack</h2>
        <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
          {botName}&apos;s team for this show. Billie @mentions them in the bot&apos;s Slack channel
          when a chat needs a person, for tickets, email replies to check and requests. With nobody
          chosen, live chats go to @here. A topic with its own person (below) goes to them first.
        </p>
      </div>
      {!slack ? (
        <Note>Once Slack is connected (Settings → Connections), choose them here.</Note>
      ) : (
        <>
          <ul className="flex flex-col gap-2" aria-label="Told in Slack">
            {people.map((p) => {
              const ticked = chosen.includes(p.id);
              const f = FOUND[slack.found[p.email] ?? "unknown"];
              return (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-start gap-3 rounded-[12px] border border-border px-3.5 py-3 has-[:checked]:border-primary has-[:checked]:bg-accent">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-[var(--color-primary)]"
                      checked={ticked}
                      disabled={!canManage}
                      aria-label={`Tell ${p.name || p.email} in Slack`}
                      onChange={() =>
                        setChosen((l) => (ticked ? l.filter((x) => x !== p.id) : [...l, p.id]))
                      }
                    />
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-semibold">{p.name || p.email}</span>
                      <Chip tone={f.tone}>{f.text}</Chip>
                      <span className="w-full text-sm break-words text-muted-foreground">
                        {p.email}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {people.some((p) => slack.found[p.email] === "missing") ? (
            <Note tone="warn">
              Billie finds people in Slack by their email. For anyone not found, make their email in
              Billie (Settings → Team) the same as their Slack account&apos;s, or they won&apos;t be
              @mentioned or able to answer in Slack.
            </Note>
          ) : null}
          {canManage ? (
            <div>
              <Button
                variant="primary"
                disabled={pending}
                onClick={() =>
                  run(() => setSlackPeopleAction({ botId, userIds: chosen }), {
                    done: () => router.refresh(),
                  })
                }
              >
                Save who&apos;s told in Slack
              </Button>
            </div>
          ) : (
            <Note>Only admins choose who&apos;s told in Slack.</Note>
          )}
        </>
      )}
    </Panel>
  );
}
