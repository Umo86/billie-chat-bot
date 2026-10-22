"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/bits";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { useRunner } from "@/components/ui/use-runner";
import { saveSettingsAction } from "@/app/actions/settings";

type Values = {
  companyName: string;
  retentionMonths: number;
  dailyAnswerCap: number;
  consentText: string;
  alertEmails: string;
  weeklySummary: boolean;
  emailSignature: string;
  emailBotId: string | null;
  whatsappVisitorBotId: string | null;
  whatsappExhibitorBotId: string | null;
};

export function GeneralForm({
  initial,
  bots,
}: {
  initial: Values;
  bots: { id: string; name: string; audience: "visitors" | "exhibitors" }[];
}) {
  const [v, setV] = useState<Values>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, run } = useRunner();
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((x) => ({ ...x, [k]: val }));
  const botSelect = (
    id: string,
    key: "emailBotId" | "whatsappVisitorBotId" | "whatsappExhibitorBotId",
  ) => (
    <Select id={id} value={v[key] ?? ""} onChange={(e) => set(key, e.target.value || null)}>
      <option value="">None</option>
      {bots.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name} ({b.audience === "visitors" ? "visitors" : "exhibitors"})
        </option>
      ))}
    </Select>
  );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        run(() => saveSettingsAction(v), {
          failed: (r) => !r.ok && setErrors(r.fieldErrors ?? {}),
        });
      }}
    >
      <Panel className="flex flex-col gap-4">
        <h2 className="text-[1.05rem]">Chat notice and privacy</h2>
        <Field
          id="consent"
          label="Notice shown at the start of every chat"
          hint="Say that it's an AI, who can see the chat and how long it's kept (UK GDPR)."
          error={errors.consentText}
        >
          <Textarea
            id="consent"
            value={v.consentText}
            maxLength={500}
            onChange={(e) => set("consentText", e.target.value)}
          />
        </Field>
        <Field
          id="retention"
          label="Keep chats and emails for (months)"
          hint="Older chats and emails are deleted automatically each night."
          error={errors.retentionMonths}
        >
          <Input
            id="retention"
            type="number"
            min={1}
            max={84}
            value={v.retentionMonths}
            onChange={(e) => set("retentionMonths", Number(e.target.value))}
            className="w-32"
          />
        </Field>
      </Panel>

      <Panel className="flex flex-col gap-4">
        <h2 className="text-[1.05rem]">Alerts</h2>
        <Field
          id="alerts"
          label="Email these people when a chat needs someone"
          hint="Comma-separated. Teams alerts are set up under Connections."
          error={errors.alertEmails}
        >
          <Input
            id="alerts"
            value={v.alertEmails}
            onChange={(e) => set("alertEmails", e.target.value)}
            placeholder="ops@media10.com"
          />
        </Field>
        <label className="flex items-center gap-3">
          <Switch
            checked={v.weeklySummary}
            onCheckedChange={(x) => set("weeklySummary", x)}
            aria-label="Weekly summary"
          />
          <span>
            Send a summary every Monday morning (questions, handovers, unanswered questions)
          </span>
        </label>
      </Panel>

      <Panel className="flex flex-col gap-4">
        <h2 className="text-[1.05rem]">Emails and WhatsApp</h2>
        <Field
          id="email-bot"
          label="Draft exhibitor email replies from"
          hint="Usually your exhibitor bot."
        >
          {botSelect("email-bot", "emailBotId")}
        </Field>
        <Field id="sig" label="Email signature" error={errors.emailSignature}>
          <Textarea
            id="sig"
            value={v.emailSignature}
            maxLength={500}
            onChange={(e) => set("emailSignature", e.target.value)}
            className="min-h-20"
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="wa-visitors" label="WhatsApp: visitors talk to">
            {botSelect("wa-visitors", "whatsappVisitorBotId")}
          </Field>
          <Field id="wa-exhibitors" label="WhatsApp: exhibitors talk to">
            {botSelect("wa-exhibitors", "whatsappExhibitorBotId")}
          </Field>
        </div>
      </Panel>

      <Panel className="flex flex-col gap-4">
        <h2 className="text-[1.05rem]">Spending limit</h2>
        <Field
          id="cap"
          label="Most answers per day, across all bots"
          hint="A safety net. When it's reached, chats go to the team until midnight."
          error={errors.dailyAnswerCap}
        >
          <Input
            id="cap"
            type="number"
            min={10}
            value={v.dailyAnswerCap}
            onChange={(e) => set("dailyAnswerCap", Number(e.target.value))}
            className="w-40"
          />
        </Field>
        <Field id="company" label="Company name" error={errors.companyName}>
          <Input
            id="company"
            value={v.companyName}
            maxLength={80}
            onChange={(e) => set("companyName", e.target.value)}
          />
        </Field>
      </Panel>

      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          Save settings
        </Button>
      </div>
    </form>
  );
}
