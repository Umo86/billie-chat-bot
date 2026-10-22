import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { Chip, Note, PageHeader } from "@/components/ui/bits";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { STEPS, WizardSteps, type StepKey } from "@/components/bots/wizard-steps";
import { LookForm } from "@/components/bots/look-form";
import { KnowledgeStep } from "@/components/bots/knowledge-step";
import { RulesStep } from "@/components/bots/rules-step";
import { TestStep } from "@/components/bots/test-step";
import { LiveStep } from "@/components/bots/live-step";
import { requireActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { botById, knowledgeBaseIdsFor } from "@/lib/bots/load";
import { knowledgeBaseList } from "@/lib/knowledge/queries";
import { appUrl, outlookConfigured, whatsappConfigured } from "@/lib/config";

export const metadata: Metadata = { title: "Bot" };
// Running a bot's test questions asks Claude once per question.
export const maxDuration = 300;

export default async function BotPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor("bots.view");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const bot = await botById(id);
  if (!bot) notFound();
  const step: StepKey = STEPS.some((s) => s.key === sp.step) ? (sp.step as StepKey) : "look";
  const canEdit = can(actor, "bots.edit");

  let body: React.ReactNode;
  if (step === "look") {
    body = canEdit ? (
      <LookForm
        botId={bot.id}
        initial={{
          name: bot.name,
          audience: bot.audience,
          showName: bot.showName,
          color: bot.color,
          avatarUrl: bot.avatarUrl,
          welcome: bot.welcome,
          starters: bot.starters,
        }}
      />
    ) : (
      <Note>Only editors can change how a bot looks.</Note>
    );
  } else if (step === "knowledge") {
    const [kbs, chosen] = await Promise.all([knowledgeBaseList(), knowledgeBaseIdsFor(bot.id)]);
    body = (
      <KnowledgeStep
        botId={bot.id}
        kbs={kbs}
        chosen={chosen}
        tone={bot.tone}
        quality={bot.quality}
        canEdit={canEdit}
      />
    );
  } else if (step === "rules") {
    body = <RulesStep botId={bot.id} initial={bot.rules} canEdit={canEdit} />;
  } else if (step === "test") {
    body = (
      <TestStep botId={bot.id} tests={bot.tests} lastRun={bot.lastTestRun} canEdit={canEdit} />
    );
  } else {
    const base = appUrl();
    const qrSvg = await QRCode.toString(`${base}/c/${bot.slug}`, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
    });
    body = (
      <LiveStep
        bot={{
          id: bot.id,
          name: bot.name,
          slug: bot.slug,
          status: bot.status,
          domains: bot.domains,
          audience: bot.audience,
          lastTestRun: bot.lastTestRun,
        }}
        appUrl={base}
        qrSvg={qrSvg}
        channels={{ whatsapp: whatsappConfigured(), outlook: outlookConfigured() }}
        can={{
          edit: canEdit,
          publish: can(actor, "bots.publish"),
          delete: can(actor, "bots.delete"),
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={bot.name}
        lede={
          <span className="inline-flex flex-wrap items-center gap-2">
            <BotAvatar name={bot.name} color={bot.color} avatarUrl={bot.avatarUrl} size={28} />
            <Chip tone={bot.status === "live" ? "good" : "neutral"}>
              {bot.status === "live" ? "Live" : "Draft"}
            </Chip>
            <Chip tone="accent">{bot.audience === "visitors" ? "Visitors" : "Exhibitors"}</Chip>
            {bot.showName ? <span>{bot.showName}</span> : null}
          </span>
        }
      />
      {sp.created ? (
        <Note tone="good">Bot created. Next, choose the knowledge it answers from.</Note>
      ) : null}
      <WizardSteps current={step} botId={bot.id} />
      {body}
    </>
  );
}
