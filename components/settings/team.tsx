"use client";

import { useState } from "react";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Field, Input, Select } from "@/components/ui/form";
import { CopyButton } from "@/components/ui/copy-button";
import { useRunner } from "@/components/ui/use-runner";
import {
  changeRoleAction,
  inviteAction,
  revokeInviteAction,
  suspendAction,
} from "@/app/actions/settings";

type Role = "admin" | "editor" | "agent";
const ROLE_HELP: Record<Role, string> = {
  admin: "Everything, including the team, settings and connections.",
  editor: "Builds bots and knowledge, and answers the Inbox and emails.",
  agent: "Answers the Inbox and emails only.",
};

export function Team({
  me,
  members,
  invitations,
}: {
  me: string;
  members: {
    id: string;
    name: string;
    email: string;
    role: Role;
    status: "active" | "suspended";
    linked: boolean;
  }[];
  invitations: { id: string; email: string; name: string; role: Role; expiresAt: string }[];
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [link, setLink] = useState<{ link: string; emailed: boolean } | null>(null);
  const invite = useRunner();
  const act = useRunner();

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-3">
        <h2 className="text-[1.05rem]">Invite someone</h2>
        <form
          className="grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_1fr_160px_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            invite.run(() => inviteAction({ email, name, role }), {
              done: (d) => {
                if (!d) return;
                setLink(d);
                setEmail("");
                setName("");
                toast.success(
                  d.emailed ? "Invitation emailed." : "Invitation ready. Copy the link below.",
                );
              },
            });
          }}
        >
          <Field id="inv-email" label="Work email">
            <Input
              id="inv-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field id="inv-name" label="Name">
            <Input
              id="inv-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </Field>
          <Field id="inv-role" label="Role">
            <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="agent">Agent</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
          <Button type="submit" variant="primary" disabled={invite.pending}>
            <UserPlus /> Invite
          </Button>
        </form>
        <p className="text-sm text-muted-foreground">{ROLE_HELP[role]}</p>
        {link ? (
          <Note tone="good">
            <p className="font-semibold">
              {link.emailed
                ? "We've emailed them this link."
                : "Email isn't set up, so send them this link yourself."}{" "}
              It works once, for 7 days.
            </p>
            <p id="invite-link" className="mt-1 break-all font-mono text-[0.85rem]">
              {link.link}
            </p>
            <CopyButton
              className="mt-2"
              text={link.link}
              label="Copy link"
              selectId="invite-link"
            />
          </Note>
        ) : null}
      </Panel>

      <Panel className="p-0 sm:p-0">
        <h2 className="px-4 pt-4 text-[1.05rem] sm:px-5">Team</h2>
        <ul className="mt-2 divide-y divide-border" aria-label="Team members">
          {members.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5"
              data-testid="member-row"
            >
              <div className="min-w-0 flex-1 basis-56">
                <p className="font-semibold">
                  {m.name}{" "}
                  {m.id === me ? (
                    <span className="text-sm font-normal text-muted-foreground">(you)</span>
                  ) : null}
                </p>
                <p className="break-all text-sm text-muted-foreground">{m.email}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {m.status === "suspended" ? <Chip tone="bad">Suspended</Chip> : null}
                {!m.linked ? <Chip tone="warn">No sign-in yet</Chip> : null}
                <Select
                  aria-label={`Role for ${m.name}`}
                  value={m.role}
                  disabled={m.id === me || act.pending}
                  onChange={(e) =>
                    act.run(() => changeRoleAction({ userId: m.id, role: e.target.value }))
                  }
                  className="w-32"
                >
                  <option value="admin">Admin</option>
                  <option value="editor">Editor</option>
                  <option value="agent">Agent</option>
                </Select>
                {m.id !== me ? (
                  <Button
                    size="sm"
                    variant={m.status === "active" ? "danger" : "default"}
                    disabled={act.pending}
                    onClick={() =>
                      act.run(() =>
                        suspendAction({ userId: m.id, suspended: m.status === "active" }),
                      )
                    }
                  >
                    {m.status === "active" ? "Suspend" : "Reactivate"}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      {invitations.length ? (
        <Panel className="flex flex-col gap-2">
          <h2 className="text-[1.05rem]">Waiting to join</h2>
          <ul className="divide-y divide-border">
            {invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="min-w-0">
                  <span className="font-semibold">{i.name}</span>{" "}
                  <span className="break-all text-sm text-muted-foreground">
                    {i.email} · {i.role} · link expires{" "}
                    {new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(
                      new Date(i.expiresAt),
                    )}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={act.pending}
                  onClick={() => act.run(() => revokeInviteAction({ id: i.id }))}
                >
                  Cancel invitation
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
