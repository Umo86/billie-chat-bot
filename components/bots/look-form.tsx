"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ImagePlus, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Note, Panel } from "@/components/ui/bits";
import { Field, Input, Textarea } from "@/components/ui/form";
import { useRunner } from "@/components/ui/use-runner";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { BOT_COLOURS, textOn } from "@/lib/bots/slug";
import { STARTER_EXAMPLES, suggestedWelcome } from "@/lib/bots/defaults";
import { BotTypeChoice } from "@/components/bots/bot-type";
import { MAX_PAGE_RULES, MAX_STARTERS } from "@/lib/bots/page-starters";
import { createBotAction, updateBotAction } from "@/app/actions/bots";
import { cn } from "@/lib/utils";

export type Look = {
  name: string;
  audience: "visitors" | "exhibitors";
  showName: string;
  color: string;
  avatarUrl: string | null;
  welcome: string;
  starters: string[];
  /** Different starters on some pages ("the page address contains …"). */
  pageStarters: { match: string; starters: string[] }[];
  /** Show days, "YYYY-MM-DD" or "" for none. */
  showFrom: string;
  showTo: string;
};

/** Shrinks a picture to a 256px square (centre crop) as a WebP data URL. */
async function toAvatar(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file isn't a picture Billie can read."));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't resize pictures.");
    ctx.drawImage(
      img,
      (img.naturalWidth - side) / 2,
      (img.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
    const webp = canvas.toDataURL("image/webp", 0.88);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The form's own copy: a new bot has no kind until one is chosen. */
type Draft = Omit<Look, "audience"> & { audience: Look["audience"] | null };

export function LookForm({
  botId,
  initial,
  hasTeamsChannel = false,
  live = false,
}: {
  botId?: string;
  initial?: Look;
  /** The event's Teams channel is set (Email step): where the morning post goes. */
  hasTeamsChannel?: boolean;
  /** The bot is live: a change of kind applies to chats straight away. */
  live?: boolean;
}) {
  const router = useRouter();
  const [look, setLook] = useState<Draft>(
    initial ?? {
      name: "",
      audience: null,
      showName: "",
      color: BOT_COLOURS[0],
      avatarUrl: null,
      welcome: "",
      starters: ["", "", ""],
      pageStarters: [],
      showFrom: "",
      showTo: "",
    },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const file = useRef<HTMLInputElement>(null);
  const { pending, run } = useRunner();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setLook((l) => ({ ...l, [k]: v }));
  const starters = [...look.starters, "", "", ""].slice(0, 3);
  // Examples and the preview follow the kind chosen (exhibitors' until one is).
  const kind = look.audience ?? "exhibitors";
  const switching = Boolean(initial && look.audience && look.audience !== initial.audience);

  // Updates nest the look ("look.name"); new bots don't ("name").
  const err = (k: string) => errors[k] ?? errors[`look.${k}`];

  function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    const { showFrom, showTo, audience, ...rest } = look;
    if (!audience) {
      setErrors({ audience: "Choose what kind of chatbot it is: for exhibitors or for visitors." });
      document.getElementById("bot-type-error")?.scrollIntoView({ block: "center" });
      return;
    }
    const payload = {
      ...rest,
      audience,
      starters: starters.map((s) => s.trim()).filter(Boolean),
      pageStarters: look.pageStarters.map((r) => ({
        match: r.match,
        starters: r.starters.map((s) => s.trim()).filter(Boolean),
      })),
      showDays: showFrom || showTo ? { from: showFrom, to: showTo } : null,
    };
    if (botId) {
      run(() => updateBotAction({ id: botId, look: payload }), {
        failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
        done: () => router.refresh(),
      });
    } else {
      run(() => createBotAction(payload), {
        failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
        done: (d) => d?.id && router.push(`/bots/${d.id}?step=personality&created=1`),
      });
    }
  }

  return (
    <form onSubmit={save} className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Panel className="flex flex-col gap-5">
        <BotTypeChoice
          value={look.audience}
          onChange={(v) => {
            set("audience", v);
            setErrors(({ audience: _chosen, ...rest }) => rest);
          }}
          error={err("audience")}
          note={
            switching && look.audience ? (
              <Note tone="warn">
                Saving makes it {look.audience === "visitors" ? "a visitor" : "an exhibitor"}{" "}
                chatbot, for {look.audience === "visitors" ? "the event website" : "BluePrint"}. It
                answers {look.audience}, and outside working hours asks for{" "}
                {look.audience === "visitors"
                  ? "their name, email and phone number"
                  : "their name, email and stand number"}{" "}
                (unless you changed that on the Rules step).{" "}
                {look.audience === "exhibitors"
                  ? "It gets an Exhibitors step for the exhibitor list and BluePrint."
                  : "The Exhibitors step goes: remove any exhibitor list, BluePrint connection and deadlines there first."}
                {live ? " It's live, so this applies to chats straight away." : ""}
              </Note>
            ) : null
          }
        />
        <Field
          id="bot-name"
          label="Bot name"
          hint={`What people see at the top of the chat, e.g. ${kind === "visitors" ? "Visitor Help" : "Exhibitor Help"}`}
          error={err("name")}
        >
          <Input
            id="bot-name"
            value={look.name}
            onChange={(e) => set("name", e.target.value)}
            maxLength={60}
            required
            aria-invalid={!!err("name")}
          />
        </Field>
        <Field id="bot-show" label="Show name" hint="e.g. UK Construction Week London 2027">
          <Input
            id="bot-show"
            value={look.showName}
            onChange={(e) => set("showName", e.target.value)}
            maxLength={80}
          />
        </Field>
        <fieldset className="flex flex-col gap-2" aria-describedby="bot-days-hint">
          <legend className="mb-1 text-[0.9rem] font-semibold">Show days (optional)</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="bot-show-from" label="First day of build-up" error={err("showDays.from")}>
              <Input
                id="bot-show-from"
                type="date"
                value={look.showFrom}
                onChange={(e) => set("showFrom", e.target.value)}
                aria-invalid={!!err("showDays.from")}
              />
            </Field>
            <Field id="bot-show-to" label="Last day of breakdown" error={err("showDays.to")}>
              <Input
                id="bot-show-to"
                type="date"
                value={look.showTo}
                onChange={(e) => set("showTo", e.target.value)}
                aria-invalid={!!err("showDays.to")}
              />
            </Field>
          </div>
          <p id="bot-days-hint" className="text-sm text-muted-foreground">
            {hasTeamsChannel
              ? "Each of these mornings, and the day after the last, Billie posts yesterday's chats and what's still waiting in the event's Teams channel at 7:30am. The end-of-show report covers these days."
              : "With the event's Teams channel set (Email step), Billie posts yesterday's chats and what's still waiting there at 7:30am each show day. The end-of-show report covers these days."}
          </p>
        </fieldset>
        <div className="flex flex-col gap-2">
          <span className="text-[0.9rem] font-semibold">Colour</span>
          <div className="flex flex-wrap items-center gap-2">
            {BOT_COLOURS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set("color", c)}
                aria-label={`Colour ${c}`}
                aria-pressed={look.color === c}
                className={cn(
                  "size-9 cursor-pointer rounded-full border-2 border-transparent",
                  look.color === c && "border-foreground",
                )}
                style={{ background: c }}
              />
            ))}
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="color"
                value={look.color}
                onChange={(e) => set("color", e.target.value)}
                className="size-9 cursor-pointer rounded-md border border-border bg-card"
                aria-label="Pick any colour"
              />
              Any colour
            </label>
          </div>
          <p className="text-sm text-muted-foreground">Use the show&apos;s brand colour.</p>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[0.9rem] font-semibold">Picture (optional)</span>
          <div className="flex flex-wrap items-center gap-3">
            <BotAvatar name={look.name} color={look.color} avatarUrl={look.avatarUrl} size={56} />
            <Button onClick={() => file.current?.click()}>
              <ImagePlus /> {look.avatarUrl ? "Change picture" : "Upload a picture"}
            </Button>
            {look.avatarUrl ? (
              <Button variant="ghost" onClick={() => set("avatarUrl", null)}>
                <Trash2 /> Remove
              </Button>
            ) : null}
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  set("avatarUrl", await toAvatar(f));
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "That picture didn't work.");
                }
              }}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            A logo or a friendly face, square works best. Without one, the bot shows its initials.
          </p>
          {err("avatarUrl") ? <Note tone="bad">{err("avatarUrl")}</Note> : null}
        </div>
        <Field id="bot-welcome" label="Welcome message" error={err("welcome")}>
          <Textarea
            id="bot-welcome"
            value={look.welcome}
            onChange={(e) => set("welcome", e.target.value)}
            maxLength={300}
            className="min-h-20"
          />
        </Field>
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => set("welcome", suggestedWelcome({ ...look, audience: kind }))}
          >
            <Sparkles /> Suggest a welcome message
          </Button>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[0.9rem] font-semibold">Starter questions (optional)</legend>
          <p className="text-sm text-muted-foreground">
            Shown as buttons when the chat opens, e.g. &ldquo;{STARTER_EXAMPLES[kind][0]}
            &rdquo;
          </p>
          {starters.map((s, i) => (
            <Input
              key={i}
              aria-label={`Starter question ${i + 1}`}
              value={s}
              maxLength={80}
              placeholder={STARTER_EXAMPLES[kind][i]}
              onChange={(e) => {
                const next = [...starters];
                next[i] = e.target.value;
                set("starters", next);
              }}
            />
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-[0.9rem] font-semibold">
            Starters for some pages (optional)
          </legend>
          <p className="text-sm text-muted-foreground">
            On a page of the show&apos;s website whose address contains these words, the chat shows
            these questions instead, e.g. &ldquo;/travel&rdquo; with &ldquo;Where can I
            park?&rdquo;. The first that matches is used. Leave the questions empty to show none
            there.
          </p>
          {look.pageStarters.map((rule, i) => {
            const update = (next: Partial<(typeof look.pageStarters)[number]>) =>
              set(
                "pageStarters",
                look.pageStarters.map((r, k) => (k === i ? { ...r, ...next } : r)),
              );
            const qs = [...rule.starters, "", "", ""].slice(0, MAX_STARTERS);
            return (
              <div
                key={i}
                className="flex flex-col gap-2 rounded-[10px] border border-border p-3"
                data-testid="page-starters"
              >
                <div className="flex items-end gap-2">
                  <Field
                    id={`page-${i}-match`}
                    label="The page address contains"
                    error={err(`pageStarters.${i}.match`)}
                    className="flex-1"
                  >
                    <Input
                      id={`page-${i}-match`}
                      value={rule.match}
                      maxLength={200}
                      placeholder="/travel"
                      onChange={(e) => update({ match: e.target.value })}
                    />
                  </Field>
                  <Button
                    variant="ghost"
                    aria-label={`Remove the starters for page ${i + 1}`}
                    onClick={() =>
                      set(
                        "pageStarters",
                        look.pageStarters.filter((_, k) => k !== i),
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
                {qs.map((q, j) => (
                  <Input
                    key={j}
                    aria-label={`Page ${i + 1}, starter question ${j + 1}`}
                    value={q}
                    maxLength={80}
                    onChange={(e) => {
                      const next = [...qs];
                      next[j] = e.target.value;
                      update({ starters: next });
                    }}
                  />
                ))}
              </div>
            );
          })}
          {look.pageStarters.length < MAX_PAGE_RULES ? (
            <div>
              <Button
                size="sm"
                onClick={() =>
                  set("pageStarters", [...look.pageStarters, { match: "", starters: [] }])
                }
              >
                <Plus /> Add starters for a page
              </Button>
            </div>
          ) : null}
        </fieldset>
        <div>
          <Button type="submit" variant="primary" disabled={pending || !look.name.trim()}>
            {botId ? "Save" : "Create bot and continue"}
          </Button>
        </div>
      </Panel>

      <div className="xl:sticky xl:top-4 xl:self-start">
        <p className="label-caps mb-2">Preview</p>
        <div className="overflow-hidden rounded-[16px] border border-border bg-card shadow-panel">
          <div
            className="flex items-center gap-3 px-4 py-3"
            style={{ background: look.color, color: textOn(look.color) }}
          >
            <BotAvatar name={look.name} color={look.color} avatarUrl={look.avatarUrl} size={36} />
            <div className="min-w-0">
              <p className="truncate font-bold">{look.name || "Your bot"}</p>
              <p className="truncate text-xs opacity-85">{look.showName || "Media10"}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 p-4">
            <p className="max-w-[85%] rounded-[14px] rounded-tl-sm bg-muted px-3 py-2 text-sm">
              {look.welcome || suggestedWelcome({ ...look, audience: kind })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {starters
                .map((s, i) => s.trim() || STARTER_EXAMPLES[kind][i])
                .map((s) => (
                  <span
                    key={s}
                    className="rounded-full border px-2.5 py-1 text-xs font-semibold"
                    style={{ borderColor: look.color, color: look.color }}
                  >
                    {s}
                  </span>
                ))}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
