"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/bits";
import { Field, Textarea } from "@/components/ui/form";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useRunner } from "@/components/ui/use-runner";
import { updateBotAction } from "@/app/actions/bots";
import { PERSONALITY_EXAMPLES, PERSONALITY_MAX, SIGN_OFF_MAX } from "@/lib/bots/defaults";

type Tone = "friendly" | "formal" | "brief";

const TONE_HELP: Record<Tone, string> = {
  friendly: "Warm and plain, like a helpful colleague.",
  formal: "Polite and precise, for contracts, rules and deadlines.",
  brief: "Short answers, straight to the point.",
};

/**
 * How the bot comes across: its tone, a description in the team's own
 * words, emoji in chats, and the sign-off on its email drafts. Style only:
 * the bot still answers only from its knowledge and follows its rules.
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
  initial: { tone: Tone; personality: string; emoji: boolean; emailSignOff: string };
  companySignOff: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, run } = useRunner();
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) =>
    setV((x) => ({ ...x, [k]: val }));

  function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    run(() => updateBotAction({ id: botId, ...v }), {
      failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
      done: () => router.push(`/bots/${botId}?step=knowledge`),
    });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-1.5">
        <h2 className="text-[1.05rem]">Tone</h2>
        <Segmented<Tone>
          className="self-start"
          label="Tone"
          value={v.tone}
          onChange={(t) => canEdit && set("tone", t)}
          options={[
            { value: "friendly", label: "Friendly" },
            { value: "formal", label: "Formal" },
            { value: "brief", label: "Brief" },
          ]}
        />
        <p className="text-sm text-muted-foreground">{TONE_HELP[v.tone]}</p>
      </Panel>

      <Panel className="flex flex-col gap-4">
        <Field
          id="personality"
          label="Personality, in your own words"
          hint={`How it should come across. It changes the style only: answers still come from its knowledge, and its rules always win. ${v.personality.length} of ${PERSONALITY_MAX} characters.`}
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
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            Save and continue
          </Button>
        </div>
      ) : null}
    </form>
  );
}
