import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileBarChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import QRCode from "qrcode";
import { Chip, Note, PageHeader, Panel } from "@/components/ui/bits";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { nextStep, stepsFor, WizardSteps, type StepKey } from "@/components/bots/wizard-steps";
import { LookForm } from "@/components/bots/look-form";
import { PersonalityStep } from "@/components/bots/personality-step";
import { KnowledgeStep } from "@/components/bots/knowledge-step";
import { ReplaceDialog } from "@/components/knowledge/replace-dialog";
import { KnowledgeWorkspace } from "@/components/knowledge/workspace";
import { RulesStep } from "@/components/bots/rules-step";
import { RequestsPanel } from "@/components/bots/requests-panel";
import { EmailStep } from "@/components/bots/email-step";
import { TestStep } from "@/components/bots/test-step";
import { LiveStep } from "@/components/bots/live-step";
import { ExhibitorsStep } from "@/components/bots/exhibitors-step";
import { listSummary } from "@/lib/exhibitors/service";
import { DeadlinesPanel } from "@/components/bots/deadlines-panel";
import { deadlineSetup } from "@/lib/exhibitors/deadlines";
import { dueLabel } from "@/lib/exhibitors/reminders";
import { daysLeft, daysUntil } from "@/lib/exhibitors/deadline-rules";
import { requireActor } from "@/lib/auth/actor";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots } from "@/lib/db/schema";
import { datesToCheck } from "@/lib/bots/copy";
import { CopyBot } from "@/components/bots/copy-bot";
import { DatesToCheck } from "@/components/bots/dates-to-check";
import { mayOnBot } from "@/lib/auth/bots";
import { botPeople } from "@/lib/bots/people";
import { PeopleStep } from "@/components/bots/people-step";
import { can } from "@/lib/authz";
import { botById } from "@/lib/bots/load";
import { knowledgeBaseOf } from "@/lib/knowledge/bases";
import {
  appUrl,
  emailConfigured,
  microsoftConfigured,
  teamsConfigured,
  whatsappConfigured,
} from "@/lib/config";
import { botEmailSetup, mailboxManagers } from "@/lib/emails/mailboxes";
import { getSettings } from "@/lib/settings";
import { londonDate, timeAgo } from "@/lib/time";

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
  if (!(await mayOnBot(actor, "bots.view", bot.id)))
    return (
      <>
        <PageHeader title={bot.name} />
        <Note tone="warn">
          You don&apos;t work on this bot. An admin can add you on its People step.
        </Note>
      </>
    );
  const steps = stepsFor(bot.audience);
  const step: StepKey = steps.some((s) => s.key === sp.step) ? (sp.step as StepKey) : "look";
  const canEdit = await mayOnBot(actor, "bots.edit", bot.id);

  let body: React.ReactNode;
  if (step === "look") {
    body = canEdit ? (
      <LookForm
        botId={bot.id}
        hasTeamsChannel={Boolean(bot.teamsWebhookUrl?.trim())}
        initial={{
          name: bot.name,
          audience: bot.audience,
          showName: bot.showName,
          color: bot.color,
          avatarUrl: bot.avatarUrl,
          welcome: bot.welcome,
          starters: bot.starters,
          pageStarters: bot.pageStarters,
          showFrom: bot.showStartsOn ?? "",
          showTo: bot.showEndsOn ?? "",
        }}
      />
    ) : (
      <Note>Only editors can change how a bot looks.</Note>
    );
  } else if (step === "personality") {
    const settings = await getSettings();
    body = (
      <PersonalityStep
        botId={bot.id}
        audience={bot.audience}
        initial={{
          tone: bot.tone,
          personality: bot.personality,
          emoji: bot.emoji,
          emailSignOff: bot.emailSignOff,
        }}
        companySignOff={settings.emailSignature}
        canEdit={canEdit}
      />
    );
  } else if (step === "knowledge") {
    const kb = await knowledgeBaseOf(bot.id);
    const canTeach = await mayOnBot(actor, "knowledge.edit", bot.id);
    body = (
      <div className="flex flex-col gap-4">
        <Panel className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[1.05rem]">What it knows</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {bot.name} answers only from what&apos;s here, and passes anything else to the team.
              This knowledge is only for this bot.
            </p>
          </div>
          {canTeach ? <ReplaceDialog kbId={kb.id} kbName={bot.name} /> : null}
        </Panel>
        <KnowledgeWorkspace kbId={kb.id} canEdit={canTeach} />
        <KnowledgeStep
          botId={bot.id}
          quality={bot.quality}
          canEdit={canEdit}
          next={nextStep("knowledge", bot.audience)}
        />
      </div>
    );
    // A copy for the next show lists every date in it until someone says they're checked.
    if (bot.copiedFromId && !bot.datesCheckedAt) {
      const [groups, from] = await Promise.all([
        datesToCheck(bot.id),
        db.query.bots.findFirst({
          where: eq(bots.id, bot.copiedFromId),
          columns: { name: true },
        }),
      ]);
      body = (
        <div className="flex flex-col gap-4">
          <DatesToCheck
            botId={bot.id}
            from={from?.name ?? null}
            groups={groups}
            canEdit={canTeach}
          />
          {body}
        </div>
      );
    }
  } else if (step === "exhibitors") {
    const [list, setup] = await Promise.all([listSummary(bot.id), deadlineSetup(bot.id)]);
    const next = nextStep("exhibitors", bot.audience);
    const today = londonDate();
    body = (
      <ExhibitorsStep
        botId={bot.id}
        botName={bot.name}
        list={
          list && {
            fileName: list.fileName,
            rows: list.rows,
            skipped: list.skipped,
            columns: list.columns,
            hiddenColumns: list.hiddenColumns,
            uploaded: `${timeAgo(list.uploadedAt)}${list.uploadedBy ? ` by ${list.uploadedBy}` : ""}`,
            sample: list.sample,
          }
        }
        personalAnswers={bot.personalAnswers}
        emailReady={emailConfigured()}
        canEdit={canEdit}
        next={next}
        nextLabel={steps.find((s) => s.key === next)!.label}
      >
        <DeadlinesPanel
          botId={bot.id}
          columns={setup.columns}
          values={setup.values}
          filled={setup.filled}
          total={setup.total}
          hasList={Boolean(list)}
          canEdit={canEdit}
          emailReady={emailConfigured()}
          deadlines={setup.deadlines.map((d) => ({
            ...d,
            due: dueLabel(d.dueOn),
            left: daysLeft(daysUntil(d.dueOn, today)),
            latest: d.latest && {
              ...d.latest,
              when: timeAgo(d.latest.sentAt ?? d.latest.createdAt),
            },
          }))}
        />
      </ExhibitorsStep>
    );
  } else if (step === "rules") {
    const people = await mailboxManagers(bot.id);
    body = (
      <div className="flex flex-col gap-4">
        <RulesStep botId={bot.id} initial={bot.rules} canEdit={canEdit} />
        <RequestsPanel
          botId={bot.id}
          initial={bot.requestTypes}
          people={people.map((p) => ({
            id: p.id,
            name: p.name ? `${p.name} (${p.email})` : p.email,
          }))}
          canEdit={canEdit}
          exhibitors={bot.audience === "exhibitors"}
        />
      </div>
    );
  } else if (step === "people") {
    body = (
      <PeopleStep
        botId={bot.id}
        botName={bot.name}
        people={await botPeople(bot.id)}
        canManage={can(actor, "team.manage")}
        routes={bot.routes}
        canRoute={canEdit}
      />
    );
  } else if (step === "email") {
    const canManage = can(actor, "settings.manage");
    const [setup, people] = await Promise.all([botEmailSetup(bot.id), mailboxManagers(bot.id)]);
    const m = setup.mailbox;
    const microsoft = microsoftConfigured();
    body = (
      <EmailStep
        key={`${m?.address ?? ""}:${m?.enabled}:${m?.assignedUserId}:${setup.teams ?? ""}`}
        botId={bot.id}
        botName={bot.name}
        mailbox={
          m ? { address: m.address, assignedUserId: m.assignedUserId, enabled: m.enabled } : null
        }
        status={
          !m
            ? null
            : !m.enabled
              ? { tone: "neutral", text: "Switched off: Billie isn't reading it." }
              : m.lastError || m.draftError
                ? { tone: "bad", text: (m.lastError ?? m.draftError)! }
                : m.lastSyncedAt
                  ? { tone: "good", text: `Last checked ${timeAgo(m.lastSyncedAt)}.` }
                  : {
                      tone: "neutral",
                      text: microsoft
                        ? "Saved. Billie checks it within a minute, and drafts replies to emails that arrive from then on."
                        : "Saved. Billie starts once Microsoft 365 is connected, with the emails that arrive from then on.",
                    }
        }
        teams={setup.teams}
        // The read-only view only needs the manager's name.
        managers={canManage ? people : people.filter((p) => p.id === m?.assignedUserId)}
        microsoft={microsoft}
        companyTeams={teamsConfigured()}
        canManage={canManage}
      />
    );
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
        channels={{
          whatsapp: whatsappConfigured(),
          mailbox: await botEmailSetup(bot.id).then((x) =>
            x.mailbox?.enabled ? x.mailbox.address : null,
          ),
        }}
        can={{
          edit: canEdit,
          publish: await mayOnBot(actor, "bots.publish", bot.id),
          delete: await mayOnBot(actor, "bots.delete", bot.id),
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
        actions={
          <span className="flex flex-wrap gap-2">
            {can(actor, "reports.view") ? (
              <Button asChild>
                <Link href={`/bots/${bot.id}/report`}>
                  <FileBarChart /> Show report
                </Link>
              </Button>
            ) : null}
            {canEdit ? (
              <CopyBot bot={{ id: bot.id, name: bot.name, showName: bot.showName }} />
            ) : null}
          </span>
        }
      />
      {sp.created ? <Note tone="good">Bot created. Next, choose how it comes across.</Note> : null}
      {sp.copied ? (
        <Note tone="good">
          Copied. Its knowledge, rules, requests, test questions and people came across. Check the
          dates below, then run the test questions. Add its websites and mailbox when you&apos;re
          ready.
          {bot.audience === "exhibitors"
            ? " The exhibitor list stays with the old show: upload this show's list on the Exhibitors step."
            : ""}
        </Note>
      ) : null}
      <WizardSteps current={step} botId={bot.id} audience={bot.audience} />
      {body}
    </>
  );
}
