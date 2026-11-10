"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Palette, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Note, Panel } from "@/components/ui/bits";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useRunner } from "@/components/ui/use-runner";
import { updateBotAction } from "@/app/actions/bots";
import { PERSONALITY_EXAMPLES } from "@/lib/bots/defaults";
import {
  AVOID_MAX,
  LENGTH_HELP,
  matchingPreset,
  PERSONALITY_MAX,
  SIGN_OFF_MAX,
  STYLE_PRESETS,
  TONE_HELP,
  type AnswerLength,
  type StylePreset,
  type Tone,
} from "@/lib/bots/style";
import { cn } from "@/lib/utils";

type Values = {
  tone: Tone;
  answerLength: AnswerLength;
  personality: string;
  emoji: boolean;
  useName: boolean;
  avoidWords: string;
  emailSignOff: string;
};

/**
 * How the bot comes across: a ready-made style to start from, its tone and
 * answer length, a description in the team's own words, emoji, names, words
 * it never uses, and the sign-off on its email drafts. Style only: the bot
 * still answers only from its knowledge and follows its rules.
 */
export function PersonalityStep({
  botId,
  audience,
  initial,
  companySignOff,
  canEdit,
}: {
  botId: string;
  audience: "visitors" | "exhibitors";
  initial: Values;
  companySignOff: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  /** Colours chosen with a style, saved with everything else. */
  const [colours, setColours] = useState<{ color: string; accentColor: string } | null>(null);
  /** The last style picked that comes with colours, to offer them. */
  const [offer, setOffer] = useState<StylePreset | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, run } = useRunner();
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((x) => ({ ...x, [k]: val }));
  const current = matchingPreset(v, audience);

  function pick(p: StylePreset) {
    if (!canEdit) return;
    const s = p.style(audience);
    setV((x) => ({ ...x, ...s, avoidWords: x.avoidWords || s.avoidWords }));
    setOffer(p.colours ? p : null);
  }

  function save(next: "knowledge" | "test") {
    setErrors({});
    run(() => updateBotAction({ id: botId, ...v, ...(colours ? { look: colours } : {}) }), {
      failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
      done: () => router.push(`/bots/${botId}?step=${next}`),
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save("knowledge");
      }}
      className="flex flex-col gap-4"
    >
      <Panel className="flex flex-col gap-3">
        <div>
          <h2 className="text-[1.05rem]">Chat style</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Start from a ready-made style, then change anything below. It changes how answers sound,
            never what they say: facts still come only from the bot&apos;s knowledge.
          </p>
        </div>
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
          role="radiogroup"
          aria-label="Chat style"
        >
          {STYLE_PRESETS.map((p) => {
            const on = current?.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!canEdit}
                onClick={() => pick(p)}
                className={cn(
                  "flex cursor-pointer flex-col gap-2 rounded-[12px] border p-3 text-left transition-colors disabled:cursor-default",
                  on
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border hover:border-foreground/40",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{p.label}</span>
                  {on ? <Check className="size-4 text-primary" aria-hidden /> : null}
                </span>
                <span className="text-sm text-muted-foreground">{p.about}</span>
                <span className="rounded-[12px] rounded-tl-sm bg-muted px-3 py-2 text-[0.85rem] italic">
                  &ldquo;{p.sample}&rdquo;
                </span>
              </button>
            );
          })}
        </div>
        {!current ? (
          <p className="text-sm text-muted-foreground">
            Your own style: the settings below don&apos;t match a ready-made one.
          </p>
        ) : null}
        {offer?.colours && canEdit ? (
          <Note className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5">
              {[offer.colours.color, offer.colours.accentColor].map((c) => (
                <span
                  key={c}
                  className="inline-block size-5 rounded-full border border-border"
                  style={{ background: c }}
                  aria-hidden
                />
              ))}
            </span>
            <span className="flex-1">
              {colours
                ? `${offer.label} colours will be used for the chat window when you save.`
                : `Use ${offer.label} colours for the chat window too?`}
            </span>
            {colours ? (
              <Button size="sm" variant="ghost" onClick={() => setColours(null)}>
                Keep my colours
              </Button>
            ) : (
              <Button size="sm" onClick={() => setColours(offer.colours!)}>
                <Palette /> Use these colours
              </Button>
            )}
          </Note>
        ) : null}
      </Panel>

      <Panel className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[1.05rem]">Tone</h2>
          <Segmented<Tone>
            className="self-start"
            label="Tone"
            value={v.tone}
            onChange={(t) => canEdit && set("tone", t)}
            options={[
              { value: "friendly", label: "Friendly" },
              { value: "formal", label: "Professional" },
              { value: "brief", label: "Brief" },
            ]}
          />
          <p className="text-sm text-muted-foreground">{TONE_HELP[v.tone]}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[1.05rem]">Answer length</h2>
          <Segmented<AnswerLength>
            className="self-start"
            label="Answer length"
            value={v.answerLength}
            onChange={(l) => canEdit && set("answerLength", l)}
            options={[
              { value: "short", label: "Short" },
              { value: "normal", label: "Normal" },
              { value: "detailed", label: "Detailed" },
            ]}
          />
          <p className="text-sm text-muted-foreground">{LENGTH_HELP[v.answerLength]}</p>
        </div>
      </Panel>

      <Panel className="flex flex-col gap-4">
        <Field
          id="personality"
          label="Personality, in your own words"
          hint={`How it should come across, e.g. who it's like and how it talks. It changes the style only: answers still come from its knowledge, and its rules always win. ${v.personality.length} of ${PERSONALITY_MAX} characters.`}
          error={errors.personality}
        >
          <Textarea
            id="personality"
            value={v.personality}
            maxLength={PERSONALITY_MAX}
            disabled={!canEdit}
            placeholder={PERSONALITY_EXAMPLES[audience]}
            aria-invalid={Boolean(errors.personality)}
            onChange={(e) => set("personality", e.target.value)}
          />
        </Field>
        {canEdit && !v.personality.trim() ? (
          <div>
            <Button
              type="button"
              size="sm"
              onClick={() => set("personality", PERSONALITY_EXAMPLES[audience])}
            >
              <Sparkles /> Use the example
            </Button>
          </div>
        ) : null}
        <label className="flex items-center gap-3">
          <Switch
            checked={v.emoji}
            disabled={!canEdit}
            onCheckedChange={(x) => set("emoji", x)}
            aria-label="Emoji in chats"
          />
          <span>
            Use the odd emoji in chats{" "}
            <span className="text-sm text-muted-foreground">(never in emails)</span>
          </span>
        </label>
        <label className="flex items-center gap-3">
          <Switch
            checked={v.useName}
            disabled={!canEdit}
            onCheckedChange={(x) => set("useName", x)}
            aria-label="Use the person's name"
          />
          <span>
            Use the person&apos;s first name now and then{" "}
            <span className="text-sm text-muted-foreground">
              (once they&apos;ve said it in the chat)
            </span>
          </span>
        </label>
        <Field
          id="avoid-words"
          label="Words it never uses (optional)"
          hint="Separate them with commas, e.g. Unfortunately, Kindly, As an AI. Used in chats and email drafts."
          error={errors.avoidWords}
        >
          <Input
            id="avoid-words"
            value={v.avoidWords}
            maxLength={AVOID_MAX}
            disabled={!canEdit}
            placeholder="Unfortunately, Kindly, As an AI"
            aria-invalid={Boolean(errors.avoidWords)}
            onChange={(e) => set("avoidWords", e.target.value)}
          />
        </Field>
      </Panel>

      <Panel className="flex flex-col gap-4">
        <Field
          id="sign-off"
          label="Email sign-off"
          hint="Ends every email draft this bot writes. Leave it empty to use the company sign-off from Settings."
          error={errors.emailSignOff}
        >
          <Textarea
            id="sign-off"
            value={v.emailSignOff}
            maxLength={SIGN_OFF_MAX}
            disabled={!canEdit}
            placeholder={companySignOff}
            aria-invalid={Boolean(errors.emailSignOff)}
            onChange={(e) => set("emailSignOff", e.target.value)}
            className="min-h-20"
          />
        </Field>
      </Panel>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            Save and continue
          </Button>
          <Button type="button" disabled={pending} onClick={() => save("test")}>
            Save and try it
          </Button>
        </div>
      ) : null}
    </form>
  );
}
