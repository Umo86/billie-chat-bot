"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Send, ThumbsDown, ThumbsUp, UserRound, X } from "lucide-react";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { textOn } from "@/lib/bots/slug";
import { FIELD_LABEL } from "@/lib/bots/defaults";
import type { PublicBot } from "@/lib/chat/public";
import type { ContactField } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The chat people see: in the website widget (mode "widget", inside the
 * /embed frame) and on the chat page (mode "page", /c/…). Talks only to
 * this app's public chat API; the chat is remembered in this browser by its
 * token, so a reload carries on where it left off.
 */
type Status = "bot" | "waiting" | "live" | "collecting" | "ticket" | "replied" | "closed";
type Msg = {
  id: string;
  role: "visitor" | "bot" | "agent" | "system";
  text: string;
  sources: { title: string; label: string }[];
  author: string | null;
  rating: number | null;
  createdAt: string;
};
type Turn = {
  conversationId: string;
  status: Status;
  token?: string;
  messages: Msg[];
  offer: { reason: string } | null;
  form: { fields: ContactField[]; promise: string } | null;
};

const POLL_MS = 3000;
let pendingSeq = 0;

function storageKey(slug: string, channel: string) {
  return `billie:${slug}:${channel}`;
}
function readToken(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeToken(key: string, token: string | null) {
  try {
    if (token) localStorage.setItem(key, token);
    else localStorage.removeItem(key);
  } catch {
    try {
      if (token) sessionStorage.setItem(key, token);
      else sessionStorage.removeItem(key);
    } catch {
      /* storage blocked: the chat lasts as long as the page */
    }
  }
}

/** Text with web addresses made into links (http and https only). */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="break-all underline"
          >
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export function ChatApp({
  bot,
  mode,
  channel,
  pageUrl,
}: {
  bot: PublicBot;
  mode: "widget" | "page";
  channel: "web" | "hosted" | "try";
  pageUrl: string | null;
}) {
  const key = storageKey(bot.slug, channel);
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status>("bot");
  const [offer, setOffer] = useState<Turn["offer"]>(null);
  const [form, setForm] = useState<Turn["form"]>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ContactField, string>>>({});
  const [restored, setRestored] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const tokenRef = useRef<string | null>(null);
  const lastAt = useRef<string | null>(null);
  const on = textOn(bot.color);

  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`/api/public/chat/${bot.slug}/${path}${sep}channel=${channel}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
          ...init.headers,
        },
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      return { res, body };
    },
    [bot.slug, channel],
  );

  const absorb = useCallback(
    (turn: Turn, replaceOffer = true) => {
      if (turn.token) {
        tokenRef.current = turn.token;
        setToken(turn.token);
        writeToken(key, turn.token);
      }
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const next = [...prev, ...turn.messages.filter((m) => !seen.has(m.id))];
        const last = next.at(-1);
        if (last) lastAt.current = last.createdAt;
        return next;
      });
      setStatus(turn.status);
      setForm(turn.form);
      if (replaceOffer) setOffer(turn.offer);
    },
    [key],
  );

  const forget = useCallback(() => {
    writeToken(key, null);
    tokenRef.current = null;
    lastAt.current = null;
    setToken(null);
    setMessages([]);
    setStatus("bot");
    setOffer(null);
    setForm(null);
  }, [key]);

  // Carry on a chat this browser already has.
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      const saved = readToken(key);
      if (saved) {
        tokenRef.current = saved;
        try {
          const { res, body } = await api("messages");
          if (cancelled) return;
          if (res.ok) {
            setToken(saved);
            absorb(body as Turn);
          } else forget();
        } catch {
          /* offline: start fresh, the token stays for next time */
        }
      } else {
        await Promise.resolve();
      }
      if (!cancelled) setRestored(true);
    }
    void restore();
    return () => {
      cancelled = true;
    };
  }, [key, api, absorb, forget]);

  // While a person has the chat, check for their replies.
  useEffect(() => {
    if (!token || !(status === "waiting" || status === "live" || status === "ticket")) return;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const after = lastAt.current ? `?after=${encodeURIComponent(lastAt.current)}` : "";
        const { res, body } = await api(`messages${after}`);
        if (res.ok) absorb(body as Turn, false);
      } catch {
        /* offline for a moment: try again next tick */
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [token, status, api, absorb]);

  // Keep the newest message in view.
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [messages, offer, form, busy]);

  async function send(raw: string) {
    const q = raw.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setText("");
    setOffer(null);
    const temp: Msg = {
      id: `pending-${++pendingSeq}`,
      role: "visitor",
      text: q,
      sources: [],
      author: null,
      rating: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, temp]);
    try {
      const { res, body } = await api("messages", {
        method: "POST",
        body: JSON.stringify({ text: q, pageUrl: pageUrl ?? undefined, channel }),
      });
      setMessages((m) => m.filter((x) => x.id !== temp.id));
      if (!res.ok) {
        setText(q);
        setError(body.error ?? "That didn't send. Try again.");
        if (res.status === 404 && tokenRef.current) forget();
        return;
      }
      absorb(body as Turn);
    } catch {
      setMessages((m) => m.filter((x) => x.id !== temp.id));
      setText(q);
      setError("You seem to be offline. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function post(path: string, payload: unknown = {}) {
    setBusy(true);
    setError(null);
    try {
      const { res, body } = await api(path, { method: "POST", body: JSON.stringify(payload) });
      if (!res.ok) {
        if (body.fieldErrors) setFieldErrors(body.fieldErrors);
        setError(body.error ?? "That didn't work. Try again.");
        return null;
      }
      return body;
    } catch {
      setError("You seem to be offline. Check your connection and try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function rate(m: Msg, rating: 1 | -1) {
    setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, rating } : x)));
    const body = await post("rating", { messageId: m.id, rating });
    if (body?.offer) setOffer(body.offer);
  }

  async function askForPerson() {
    setOffer(null);
    const turn = await post("handover");
    if (turn) absorb(turn as Turn);
  }

  async function leaveDetails(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    const turn = await post("details", { contact: data });
    if (turn) absorb(turn as Turn);
  }

  const agent = [...messages].reverse().find((m) => m.role === "agent")?.author;
  const empty = restored && messages.length === 0;
  const lastBot = [...messages].reverse().find((m) => m.role === "bot");

  return (
    <section
      aria-label={`Chat with ${bot.name}`}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-card text-foreground",
        mode === "widget"
          ? "h-dvh"
          : "h-dvh sm:h-[min(860px,calc(100dvh-48px))] sm:rounded-[18px] sm:border sm:border-border sm:shadow-panel",
      )}
    >
      <header
        className="flex shrink-0 items-center gap-3 px-4 py-3"
        style={{ background: bot.color, color: on }}
      >
        <BotAvatar name={bot.name} color={bot.color} avatarUrl={bot.avatarUrl} size={38} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[1.02rem] font-bold" style={{ color: on }}>
            {bot.name}
          </h1>
          <p className="truncate text-[0.8rem] opacity-85">
            {status === "live"
              ? `Chatting with ${agent ?? "the team"}`
              : status === "waiting"
                ? "Connecting you to the team…"
                : bot.showName || "Media10"}
          </p>
        </div>
        {channel === "try" ? (
          <span className="rounded-md bg-black/20 px-2 py-0.5 text-[0.72rem] font-bold">TEST</span>
        ) : null}
        {mode === "widget" ? (
          <button
            type="button"
            onClick={() => window.parent.postMessage({ type: "billie:close" }, "*")}
            className="grid size-9 cursor-pointer place-items-center rounded-full hover:bg-black/10"
            aria-label="Close chat"
          >
            <X className="size-5" />
          </button>
        ) : null}
      </header>

      <ol
        ref={list}
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-4"
        aria-live="polite"
        aria-relevant="additions"
      >
        <li className="self-center px-2 text-center text-[0.76rem] text-muted-foreground">
          {bot.consent}
        </li>
        <li className="flex max-w-[88%] flex-col gap-1">
          <p className="whitespace-pre-wrap rounded-[16px] rounded-tl-sm bg-muted px-3.5 py-2.5 text-[0.94rem]">
            {bot.welcome || `Hi, I'm ${bot.name}. How can I help?`}
          </p>
        </li>
        {empty && bot.starters.length ? (
          <li className="flex flex-wrap gap-1.5" aria-label="Suggested questions">
            {bot.starters.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="cursor-pointer rounded-full border px-3 py-1.5 text-[0.85rem] font-semibold hover:bg-muted"
                style={{ borderColor: bot.color, color: "var(--foreground)" }}
              >
                {s}
              </button>
            ))}
          </li>
        ) : null}
        {messages.map((m) =>
          m.role === "visitor" ? (
            <li
              key={m.id}
              className="max-w-[85%] self-end whitespace-pre-wrap rounded-[16px] rounded-tr-sm px-3.5 py-2.5 text-[0.94rem]"
              style={{ background: bot.color, color: on }}
            >
              {m.text}
            </li>
          ) : m.role === "system" ? (
            <li
              key={m.id}
              className="self-center px-3 text-center text-[0.84rem] text-muted-foreground"
            >
              {m.text}
            </li>
          ) : (
            <li key={m.id} className="flex max-w-[88%] flex-col gap-1">
              {m.role === "agent" ? (
                <span className="flex items-center gap-1 text-[0.75rem] font-semibold text-muted-foreground">
                  <UserRound className="size-3.5" aria-hidden /> {m.author ?? "The team"}
                </span>
              ) : null}
              <p
                className={cn(
                  "whitespace-pre-wrap rounded-[16px] rounded-tl-sm px-3.5 py-2.5 text-[0.94rem]",
                  m.role === "agent" ? "border border-border bg-card" : "bg-muted",
                )}
              >
                <Linked text={m.text} />
              </p>
              {m.role === "bot" && m.sources.length ? (
                <p className="px-1 text-[0.74rem] text-muted-foreground">
                  Source:{" "}
                  {m.sources.map((s) => `${s.title}${s.label ? ` (${s.label})` : ""}`).join("; ")}
                </p>
              ) : null}
              {m.role === "bot" && m.id === lastBot?.id && status === "bot" ? (
                <div className="flex gap-1 px-0.5">
                  <button
                    type="button"
                    aria-label="Helpful"
                    aria-pressed={m.rating === 1}
                    onClick={() => rate(m, 1)}
                    className={cn(
                      "grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-muted",
                      m.rating === 1 && "text-good",
                    )}
                  >
                    <ThumbsUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Not helpful"
                    aria-pressed={m.rating === -1}
                    onClick={() => rate(m, -1)}
                    className={cn(
                      "grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-muted",
                      m.rating === -1 && "text-bad",
                    )}
                  >
                    <ThumbsDown className="size-3.5" />
                  </button>
                </div>
              ) : null}
            </li>
          ),
        )}
        {busy && !form ? (
          <li
            className="flex items-center gap-1 px-2 py-1"
            role="status"
            aria-label={`${bot.name} is typing`}
          >
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.2s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.1s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
          </li>
        ) : null}
        {offer && status === "bot" ? (
          <li className="flex flex-col gap-2 rounded-[14px] border border-border p-3">
            <p className="text-[0.92rem] font-semibold">
              Would you like me to pass this to the team?
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={askForPerson}
                className="cursor-pointer rounded-full px-3.5 py-1.5 text-[0.88rem] font-bold"
                style={{ background: bot.color, color: on }}
              >
                Yes, pass it on
              </button>
              <button
                type="button"
                onClick={() => setOffer(null)}
                className="cursor-pointer rounded-full border border-border px-3.5 py-1.5 text-[0.88rem] font-semibold"
              >
                No thanks
              </button>
            </div>
          </li>
        ) : null}
        {form && status === "collecting" ? (
          <li>
            <form
              onSubmit={leaveDetails}
              className="flex flex-col gap-2.5 rounded-[14px] border border-border p-3"
              aria-label="Leave your details"
            >
              <p className="text-[0.92rem] font-semibold">
                Nobody is free right now. Leave your details and the team will reply {form.promise}.
              </p>
              {form.fields.map((f) => (
                <label key={f} className="flex flex-col gap-1 text-[0.85rem] font-semibold">
                  {FIELD_LABEL[f]}
                  {f === "name" || f === "email" ? "" : " (optional)"}
                  <input
                    name={f}
                    type={f === "email" ? "email" : f === "phone" ? "tel" : "text"}
                    autoComplete={
                      f === "name"
                        ? "name"
                        : f === "email"
                          ? "email"
                          : f === "phone"
                            ? "tel"
                            : f === "company"
                              ? "organization"
                              : "off"
                    }
                    required={f === "name" || f === "email"}
                    maxLength={200}
                    aria-invalid={!!fieldErrors[f]}
                    className="rounded-[9px] border border-input bg-card px-3 py-2 text-[0.94rem] font-normal"
                  />
                  {fieldErrors[f] ? (
                    <span className="text-[0.8rem] font-normal text-bad">{fieldErrors[f]}</span>
                  ) : null}
                </label>
              ))}
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="cursor-pointer rounded-full px-3.5 py-1.5 text-[0.88rem] font-bold disabled:opacity-60"
                  style={{ background: bot.color, color: on }}
                >
                  Send my details
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const turn = await post("cancel");
                    if (turn) absorb(turn as Turn);
                  }}
                  className="cursor-pointer rounded-full border border-border px-3.5 py-1.5 text-[0.88rem] font-semibold"
                >
                  Keep chatting with {bot.name}
                </button>
              </div>
            </form>
          </li>
        ) : null}
      </ol>

      <div className="shrink-0 border-t border-border px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2.5">
        {error ? (
          <p
            role="alert"
            className="mb-2 rounded-[9px] bg-bad-soft px-3 py-2 text-[0.85rem] text-bad"
          >
            {error}
          </p>
        ) : null}
        {status === "ticket" ? (
          <p className="mb-2 text-[0.8rem] text-muted-foreground">
            The team has your details. Anything you add here goes to them too.
          </p>
        ) : null}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <label htmlFor="chat-input" className="sr-only">
            Your message
          </label>
          <textarea
            id="chat-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text);
              }
            }}
            rows={1}
            maxLength={2000}
            placeholder={status === "live" ? "Write to the team…" : "Ask a question…"}
            className="max-h-32 min-h-[42px] flex-1 resize-none rounded-[12px] border border-input bg-card px-3 py-2.5 text-[0.95rem]"
          />
          <button
            type="submit"
            disabled={busy || !text.trim()}
            aria-label="Send"
            className="grid size-[42px] shrink-0 cursor-pointer place-items-center rounded-full disabled:opacity-50"
            style={{ background: bot.color, color: on }}
          >
            <Send className="size-[18px]" />
          </button>
        </form>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[0.74rem] text-muted-foreground">
          {status === "bot" ? (
            <button
              type="button"
              onClick={askForPerson}
              disabled={busy || messages.length === 0}
              className="cursor-pointer font-semibold underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-60"
            >
              Talk to a person
            </button>
          ) : (
            <span />
          )}
          <span>Answers can be wrong. Don&apos;t share card details.</span>
        </div>
      </div>
    </section>
  );
}
