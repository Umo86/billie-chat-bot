"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ImagePlus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Note, Panel } from "@/components/ui/bits";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Segmented } from "@/components/ui/segmented";
import { useRunner } from "@/components/ui/use-runner";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { BOT_COLOURS, textOn } from "@/lib/bots/slug";
import { STARTER_EXAMPLES, suggestedWelcome } from "@/lib/bots/defaults";
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

export function LookForm({ botId, initial }: { botId?: string; initial?: Look }) {
  const router = useRouter();
  const [look, setLook] = useState<Look>(
    initial ?? {
      name: "",
      audience: "exhibitors",
      showName: "",
      color: BOT_COLOURS[0],
      avatarUrl: null,
      welcome: "",
      starters: ["", "", ""],
    },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const file = useRef<HTMLInputElement>(null);
  const { pending, run } = useRunner();
  const set = <K extends keyof Look>(k: K, v: Look[K]) => setLook((l) => ({ ...l, [k]: v }));
  const starters = [...look.starters, "", "", ""].slice(0, 3);

  function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    const payload = { ...look, starters: starters.map((s) => s.trim()).filter(Boolean) };
    if (botId) {
      run(() => updateBotAction({ id: botId, look: payload }), {
        failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
        done: () => router.refresh(),
      });
    } else {
      run(() => createBotAction(payload), {
        failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
        done: (d) => d?.id && router.push(`/bots/${d.id}?step=knowledge&created=1`),
      });
    }
  }

  return (
    <form onSubmit={save} className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Panel className="flex flex-col gap-5">
        <Field
          id="bot-name"
          label="Bot name"
          hint="What visitors see at the top of the chat, e.g. Exhibitor Help"
          error={errors.name}
        >
          <Input
            id="bot-name"
            value={look.name}
            onChange={(e) => set("name", e.target.value)}
            maxLength={60}
            required
            aria-invalid={!!errors.name}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.9rem] font-semibold">Who is it for?</span>
          <Segmented<Look["audience"]>
            label="Who is it for"
            value={look.audience}
            onChange={(v) => set("audience", v)}
            options={[
              { value: "exhibitors", label: "Exhibitors" },
              { value: "visitors", label: "Visitors" },
            ]}
          />
          <p className="text-sm text-muted-foreground">
            {look.audience === "exhibitors"
              ? "For the exhibitor manual site: build-up, deliveries, badges, stand rules and prices."
              : "For the show website: dates, opening times, travel, tickets and what's on."}
          </p>
        </div>
        <Field id="bot-show" label="Show name" hint="e.g. UK Construction Week London 2027">
          <Input
            id="bot-show"
            value={look.showName}
            onChange={(e) => set("showName", e.target.value)}
            maxLength={80}
          />
        </Field>
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
          {errors.avatarUrl ? <Note tone="bad">{errors.avatarUrl}</Note> : null}
        </div>
        <Field id="bot-welcome" label="Welcome message" error={errors.welcome}>
          <Textarea
            id="bot-welcome"
            value={look.welcome}
            onChange={(e) => set("welcome", e.target.value)}
            maxLength={300}
            className="min-h-20"
          />
        </Field>
        <div>
          <Button size="sm" variant="ghost" onClick={() => set("welcome", suggestedWelcome(look))}>
            <Sparkles /> Suggest a welcome message
          </Button>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[0.9rem] font-semibold">Starter questions (optional)</legend>
          <p className="text-sm text-muted-foreground">
            Shown as buttons when the chat opens, e.g. &ldquo;{STARTER_EXAMPLES[look.audience][0]}
            &rdquo;
          </p>
          {starters.map((s, i) => (
            <Input
              key={i}
              aria-label={`Starter question ${i + 1}`}
              value={s}
              maxLength={80}
              placeholder={STARTER_EXAMPLES[look.audience][i]}
              onChange={(e) => {
                const next = [...starters];
                next[i] = e.target.value;
                set("starters", next);
              }}
            />
          ))}
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
              {look.welcome || suggestedWelcome(look)}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {starters
                .map((s, i) => s.trim() || STARTER_EXAMPLES[look.audience][i])
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
