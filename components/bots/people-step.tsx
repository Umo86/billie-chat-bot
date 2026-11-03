"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { useRunner } from "@/components/ui/use-runner";
import { setBotPeopleAction } from "@/app/actions/bots";

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
}: {
  botId: string;
  botName: string;
  people: Person[];
  canManage: boolean;
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
      <div>
        <Button asChild>
          <Link href={`/bots/${botId}?step=email`}>Continue to Email</Link>
        </Button>
      </div>
    </div>
  );
}
