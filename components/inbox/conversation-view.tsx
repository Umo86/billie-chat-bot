"use client";

import { useState } from "react";
import { BookmarkPlus, Download, RotateCcw, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import {
  closeChatAction,
  handBackAction,
  replyAction,
  saveAsAnswerAction,
} from "@/app/actions/inbox";
import type { TranscriptLine } from "@/lib/conversations/inbox";
import type { ContactDetails } from "@/lib/types";
import { cn } from "@/lib/utils";

type Status = "bot" | "waiting" | "live" | "collecting" | "ticket" | "replied" | "closed";

const STATUS: Record<Status, { label: string; tone: "warn" | "good" | "info" | "neutral" }> = {
  bot: { label: "With Billie", tone: "neutral" },
  waiting: { label: "Waiting for a person", tone: "warn" },
  live: { label: "Live", tone: "good" },
  collecting: { label: "Taking details", tone: "info" },
  ticket: { label: "Needs a reply", tone: "warn" },
  replied: { label: "Replied", tone: "neutral" },
  closed: { label: "Closed", tone: "neutral" },
};

function time(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

export function ConversationView({
  id,
  status,
  channel,
  botName,
  contact,
  waId,
  pageUrl,
  assignedName,
  lines,
  kbs,
  canTeach,
  replyHint,
}: {
  id: string;
  status: Status;
  channel: "web" | "hosted" | "whatsapp" | "try";
  botName: string;
  contact: ContactDetails;
  waId: string | null;
  pageUrl: string | null;
  assignedName: string | null;
  lines: TranscriptLine[];
  kbs: { id: string; name: string }[];
  canTeach: boolean;
  replyHint: string | null;
}) {
  const [text, setText] = useState("");
  const [teach, setTeach] = useState<{ question: string; answer: string; kbId: string } | null>(
    null,
  );
  const reply = useRunner();
  const act = useRunner();
  const teachRun = useRunner();
  const canReply = status !== "closed";

  return (
    <Panel className="flex min-h-[560px] flex-col gap-0 p-0 sm:p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[1.05rem]">{contact.name || (waId ? `+${waId}` : "Visitor")}</h2>
            <Chip tone={STATUS[status].tone}>{STATUS[status].label}</Chip>
            {channel === "try" ? <Chip>TEST</Chip> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {botName} ·{" "}
            {channel === "whatsapp"
              ? "WhatsApp"
              : channel === "hosted"
                ? "Chat page"
                : channel === "try"
                  ? "Try page"
                  : "Website"}
            {assignedName ? ` · with ${assignedName}` : ""}
          </p>
          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
            {(["company", "stand", "email", "phone"] as const).map((k) =>
              contact[k] ? (
                <div key={k} className="flex gap-1">
                  <dt className="text-muted-foreground capitalize">{k}:</dt>
                  <dd className="break-all">{contact[k]}</dd>
                </div>
              ) : null,
            )}
            {pageUrl ? (
              <div className="flex min-w-0 gap-1">
                <dt className="text-muted-foreground">Page:</dt>
                <dd className="truncate">{pageUrl}</dd>
              </div>
            ) : null}
          </dl>
        </div>
        <div className="flex flex-wrap gap-2">
          {status === "waiting" || status === "live" ? (
            <Button
              size="sm"
              disabled={act.pending}
              onClick={() => act.run(() => handBackAction({ conversationId: id }))}
            >
              <RotateCcw /> Back to Billie
            </Button>
          ) : null}
          {status !== "closed" ? (
            <Button
              size="sm"
              disabled={act.pending}
              onClick={() => act.run(() => closeChatAction({ conversationId: id }))}
            >
              <XCircle /> Close
            </Button>
          ) : null}
          <Button asChild size="sm" variant="ghost">
            <a href={`/api/inbox/${id}/export`}>
              <Download /> Export
            </a>
          </Button>
        </div>
      </div>

      <ol
        className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-4 sm:px-5"
        aria-label="Messages"
      >
        {lines.map((l) => (
          <li
            key={l.id}
            className={cn(
              "flex max-w-[86%] flex-col gap-1",
              l.role === "agent" && "self-end items-end",
              l.role === "system" && "max-w-full self-center items-center",
            )}
          >
            <span className="text-[0.75rem] text-muted-foreground">
              {l.role === "visitor"
                ? "Visitor"
                : l.role === "bot"
                  ? botName
                  : l.role === "agent"
                    ? (l.author ?? "Team")
                    : "Note"}{" "}
              · {time(l.createdAt)}
              {l.rating === 1 ? " · 👍" : l.rating === -1 ? " · 👎" : ""}
            </span>
            <p
              className={cn(
                "whitespace-pre-wrap rounded-[14px] px-3 py-2 text-[0.93rem]",
                l.role === "visitor" && "rounded-tl-sm bg-muted",
                l.role === "bot" && "rounded-tl-sm border border-border bg-card",
                l.role === "agent" && "rounded-tr-sm bg-primary text-primary-foreground",
                l.role === "system" &&
                  "bg-transparent px-0 py-0 text-center text-sm text-muted-foreground",
              )}
            >
              {l.text}
            </p>
            {l.role === "bot" && l.sources.length ? (
              <span className="text-[0.74rem] text-muted-foreground">
                Source:{" "}
                {l.sources.map((s) => `${s.title}${s.label ? ` (${s.label})` : ""}`).join("; ")}
              </span>
            ) : null}
            {l.role === "visitor" && canTeach && kbs.length ? (
              <button
                type="button"
                className="cursor-pointer text-[0.75rem] font-semibold text-primary hover:underline"
                onClick={() =>
                  setTeach({ question: l.text.slice(0, 300), answer: "", kbId: kbs[0].id })
                }
              >
                <BookmarkPlus className="mr-1 inline size-3.5" aria-hidden />
                Save an answer for this
              </button>
            ) : null}
          </li>
        ))}
      </ol>

      {canReply ? (
        <form
          className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:px-5"
          onSubmit={(e) => {
            e.preventDefault();
            reply.run(() => replyAction({ conversationId: id, text }), { done: () => setText("") });
          }}
        >
          {replyHint ? <Note className="text-sm">{replyHint}</Note> : null}
          <label htmlFor="reply" className="sr-only">
            Reply
          </label>
          <Textarea
            id="reply"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                e.currentTarget.form?.requestSubmit();
            }}
            placeholder={
              status === "bot"
                ? "Write to step in. Billie stops answering this chat."
                : "Write a reply…"
            }
            className="min-h-20"
            maxLength={4000}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Ctrl+Enter or ⌘+Enter to send</span>
            <Button type="submit" variant="primary" disabled={reply.pending || !text.trim()}>
              <Send /> Send
            </Button>
          </div>
        </form>
      ) : null}

      <Dialog open={!!teach} onOpenChange={(o) => !o && setTeach(null)}>
        {teach ? (
          <DialogContent
            title="Save an answer"
            description="Billie will use this answer for the same question from now on."
          >
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                teachRun.run(() => saveAsAnswerAction(teach), { done: () => setTeach(null) });
              }}
            >
              <Field id="teach-q" label="Question">
                <Input
                  id="teach-q"
                  value={teach.question}
                  maxLength={300}
                  onChange={(e) => setTeach({ ...teach, question: e.target.value })}
                />
              </Field>
              <Field id="teach-a" label="Answer">
                <Textarea
                  id="teach-a"
                  value={teach.answer}
                  maxLength={4000}
                  autoFocus
                  onChange={(e) => setTeach({ ...teach, answer: e.target.value })}
                />
              </Field>
              {kbs.length > 1 ? (
                <Field id="teach-kb" label="Save it in">
                  <Select
                    id="teach-kb"
                    value={teach.kbId}
                    onChange={(e) => setTeach({ ...teach, kbId: e.target.value })}
                  >
                    {kbs.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <div className="flex justify-end gap-2">
                <DialogClose asChild>
                  <Button>Cancel</Button>
                </DialogClose>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={teachRun.pending || !teach.answer.trim()}
                >
                  Save answer
                </Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </Panel>
  );
}
