"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Input, Label } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { saveRoutesAction, setBotPeopleAction } from "@/app/actions/bots";
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
}: {
  botId: string;
  botName: string;
  people: Person[];
  canManage: boolean;
  /** Who handles what: a topic, its words, and the person it goes to first. */
  routes: { id: string; topic: string; words: string[]; userId: string }[];
  canRoute: boolean;
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
