import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { Chip, PageHeader, Panel } from "@/components/ui/bits";
import { TabsNav } from "@/components/ui/tabs-nav";
import { CopyButton } from "@/components/ui/copy-button";
import { GeneralForm } from "@/components/settings/general-form";
import { Team } from "@/components/settings/team";
import { Privacy } from "@/components/settings/privacy";
import { TeamsDirect } from "@/components/settings/teams-direct";
import { SlackSetup } from "@/components/settings/slack-setup";
import { TwentyCheck } from "@/components/settings/twenty-check";
import { twentyConfigured, twentyHost } from "@/lib/crm/lead-rules";
import { slackStatus } from "@/lib/alerts/slack-settings";
import { slackManifest, slackManifestJson } from "@/lib/channels/slack-manifest";
import { AiUsage } from "@/components/settings/ai-usage";
import { ModelsForm } from "@/components/settings/models-form";
import { SavingsForm } from "@/components/settings/savings-form";
import { BudgetForm } from "@/components/settings/budget-form";
import { budgetNow, monthName } from "@/lib/ai/budget";
import { aiUsageReport, PERIODS, type Period } from "@/lib/ai/report";
import { MODELS, priceLine, usd } from "@/lib/ai/pricing";
import { modelFor } from "@/lib/ai/models";
import { requireActor } from "@/lib/auth/actor";
import { roleWorksOnEveryBot } from "@/lib/authz";
import { authMode } from "@/lib/auth/config";
import { getSettings } from "@/lib/settings";
import { botCards } from "@/lib/bots/queries";
import { openInvitations, teamMembers } from "@/lib/team/queries";
import { botsByPerson } from "@/lib/bots/people";
import { mailboxOverview } from "@/lib/emails/mailboxes";
import { directLinkLabel } from "@/lib/alerts/direct";
import { timeAgo } from "@/lib/time";
import {
  aiProvider,
  appUrl,
  blobConfigured,
  embeddingsProvider,
  emailConfigured,
  microsoftConfigured,
  teamsConfigured,
  whatsappConfigured,
} from "@/lib/config";
import { appDatabaseUrl, describeDatabase, isNeon } from "@/lib/db/urls";

export const metadata: Metadata = { title: "Settings" };

type Tab = "general" | "team" | "privacy" | "connections" | "ai";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor("settings.manage");
  const sp = await searchParams;
  const tab: Tab =
    sp.tab === "team" || sp.tab === "privacy" || sp.tab === "connections" || sp.tab === "ai"
      ? sp.tab
      : "general";

  let body: React.ReactNode;
  if (tab === "ai") {
    const period: Period = PERIODS.some((p) => p.key === sp.period)
      ? (sp.period as Period)
      : "month";
    const [report, s, budget] = await Promise.all([
      aiUsageReport(period),
      getSettings(),
      budgetNow(),
    ]);
    const chosen = { fast: s.fastModel, thorough: s.thoroughModel };
    body = (
      <div className="flex flex-col gap-4">
        <ModelsForm
          models={MODELS.map((m) => ({
            id: m.id,
            name: m.name,
            blurb: m.blurb,
            prices: priceLine(m),
          }))}
          initial={{ fast: modelFor("fast", chosen), thorough: modelFor("thorough", chosen) }}
        />
        <BudgetForm
          initial={{
            dollars: s.monthlyBudgetCents === null ? null : s.monthlyBudgetCents / 100,
            hardStop: s.budgetHardStop,
          }}
          spent={{ label: usd(budget.spentMicros), pct: budget.pct }}
          month={monthName(budget.month)}
        />
        <SavingsForm initial={{ tryFastFirst: s.tryFastFirst, reuseAnswers: s.reuseAnswers }} />
        <AiUsage periods={PERIODS} period={period} report={report} />
        <p className="text-sm text-muted-foreground">
          The daily limit on answers ({s.dailyAnswerCap.toLocaleString("en-GB")} a day) is in{" "}
          <Link href="/settings" className="font-semibold text-primary">
            General
          </Link>
          .
        </p>
      </div>
    );
  } else if (tab === "general") {
    const [s, bots] = await Promise.all([getSettings(), botCards(null)]);
    body = (
      <GeneralForm
        bots={bots.map((b) => ({ id: b.id, name: b.name, audience: b.audience }))}
        initial={{
          companyName: s.companyName,
          retentionMonths: s.retentionMonths,
          nudgeAfterHours: s.nudgeAfterHours,
          escalateAfterHours: s.escalateAfterHours,
          dailyAnswerCap: s.dailyAnswerCap,
          consentText: s.consentText,
          alertEmails: s.alertEmails,
          weeklySummary: s.weeklySummary,
          emailSignature: s.emailSignature,
          emailBotId: s.emailBotId,
          whatsappVisitorBotId: s.whatsappVisitorBotId,
          whatsappExhibitorBotId: s.whatsappExhibitorBotId,
        }}
      />
    );
  } else if (tab === "team") {
    const [members, invitations, byPerson, bots] = await Promise.all([
      teamMembers(),
      openInvitations(),
      botsByPerson(),
      botCards(null),
    ]);
    body = (
      <Team
        me={actor.id}
        members={members.map((m) => ({
          ...m,
          linked: Boolean(m.linked),
          everyBot: roleWorksOnEveryBot(m.role),
          bots: (byPerson.get(m.id) ?? []).map((b) => b.name),
        }))}
        invitations={invitations.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() }))}
        bots={bots.map((b) => ({ id: b.id, name: b.name }))}
      />
    );
  } else if (tab === "privacy") {
    const s = await getSettings();
    body = <Privacy retentionMonths={s.retentionMonths} />;
  } else {
    const base = appUrl();
    const dbUrl = appDatabaseUrl();
    const [mailboxes, direct, slack, s] = await Promise.all([
      mailboxOverview(),
      directLinkLabel(),
      slackStatus(),
      getSettings(),
    ]);
    const microsoft = microsoftConfigured();
    const rows: { name: string; ok: boolean; detail: string; vars?: string }[] = [
      {
        name: "Database",
        ok: Boolean(dbUrl),
        detail: dbUrl
          ? `${isNeon(dbUrl) ? "Neon Postgres" : "Postgres"} · ${describeDatabase(dbUrl)}`
          : "Not set up",
        vars: "DATABASE_URL, DIRECT_DATABASE_URL",
      },
      {
        name: "Sign-in",
        ok: authMode() === "neon",
        detail:
          authMode() === "neon"
            ? "Neon Auth"
            : authMode() === "local"
              ? "Test stand-in (not for real use)"
              : "Not set up",
        vars: "NEON_AUTH_BASE_URL",
      },
      {
        name: "Claude (answers and drafts)",
        ok: aiProvider() === "anthropic",
        detail:
          aiProvider() === "anthropic"
            ? "Connected"
            : aiProvider() === "fake"
              ? "Test stand-in"
              : "Not set up",
        vars: "ANTHROPIC_API_KEY",
      },
      {
        name: "Search (Voyage embeddings)",
        ok: embeddingsProvider() === "voyage",
        detail:
          embeddingsProvider() === "voyage"
            ? "Connected"
            : "Keyword search only until connected (answers still work)",
        vars: "VOYAGE_API_KEY",
      },
      {
        name: "File storage (Vercel Blob)",
        ok: blobConfigured(),
        detail: blobConfigured() ? "Connected" : "Not set up: needed for uploads on the live site",
        vars: "BLOB_READ_WRITE_TOKEN",
      },
      {
        name: "Email out (Resend)",
        ok: emailConfigured(),
        detail: emailConfigured()
          ? "Connected"
          : "Invitations and alerts show links instead of emailing",
        vars: "RESEND_API_KEY, EMAIL_FROM",
      },
      {
        name: "Microsoft 365 (event mailboxes)",
        ok: microsoft,
        detail: microsoft
          ? `Connected. ${mailboxes.length} event ${mailboxes.length === 1 ? "mailbox" : "mailboxes"} set up on bots.`
          : "Not connected: paste emails into Emails until it is. IT steps below.",
        vars: "MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET",
      },
      {
        name: "WhatsApp",
        ok: whatsappConfigured(),
        detail: whatsappConfigured() ? "Connected" : "Not set up",
        vars: "WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN",
      },
      {
        name: "Slack (the team)",
        ok: slack.connected && !slack.problem,
        detail: !slack.connected
          ? "Not connected: set it up below, about 10 minutes."
          : slack.problem
            ? slack.problem
            : `Connected to ${slack.team || "your workspace"}. Chats that need a person, email replies to check and the bots' posts go to Slack.`,
        vars: "SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET",
      },
      // Teams, until Slack is connected.
      ...(slack.connected
        ? []
        : [
            {
              name: "Teams messages to people",
              ok: Boolean(direct),
              detail: direct
                ? "On. Mailbox managers and whoever is available get a Teams chat."
                : "Off. Set it up below: one Teams workflow, about 10 minutes for IT.",
            },
            {
              name: "Teams (company-wide channel)",
              ok: teamsConfigured(),
              detail: teamsConfigured()
                ? "Connected. Chats from bots without their own channel are posted here."
                : "Optional. Each bot can post to its event's own channel (set on its Email step).",
              vars: "TEAMS_WEBHOOK_URL",
            },
          ]),
    ];
    rows.push({
      name: "Twenty CRM (sales leads)",
      ok: twentyConfigured(),
      detail: twentyConfigured()
        ? `Connected to ${twentyHost()}. Forms marked as sales leads (such as Interested in exhibiting) go to Twenty as a person, their company, an opportunity and a note.`
        : "Optional. Visitor bots' Interested in exhibiting form can send each lead to Twenty. Make an API key in Twenty (Settings → Developers → API → Create key).",
      vars: "TWENTY_API_KEY (plus TWENTY_API_URL if Twenty runs on your own server)",
    });
    body = (
      <div className="flex flex-col gap-4">
        <Panel className="p-0 sm:p-0">
          <ul className="divide-y divide-border" aria-label="Connections">
            {rows.map((r) => (
              <li key={r.name} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:px-5">
                {r.ok ? (
                  <CheckCircle2
                    className="mt-0.5 size-5 shrink-0 text-good"
                    aria-label="Connected"
                  />
                ) : (
                  <CircleDashed
                    className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                    aria-label="Not connected"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{r.name}</p>
                  <p className="text-sm text-muted-foreground">{r.detail}</p>
                  {!r.ok && r.vars ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Set in Vercel → Settings → Environment Variables: <code>{r.vars}</code>
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
        <SlackSetup
          slack={slack}
          manifest={slackManifest(base)}
          manifestJson={slackManifestJson(base)}
          channelId={s.slackChannelId ?? null}
        />
        {slack.connected ? null : <TeamsDirect saved={direct} me={actor.email} />}
        {twentyConfigured() ? <TwentyCheck /> : null}
        <Panel className="flex flex-col gap-3">
          <h2 className="text-[1.05rem]">Event mailboxes</h2>
          {mailboxes.length ? (
            <ul className="flex flex-col divide-y divide-border" aria-label="Event mailboxes">
              {mailboxes.map((m) => (
                <li key={m.botId} className="flex flex-wrap items-start gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-semibold">{m.address}</p>
                    <p className="text-sm text-muted-foreground">
                      <Link
                        href={`/bots/${m.botId}?step=email`}
                        className="font-semibold text-primary"
                      >
                        {m.botName}
                      </Link>{" "}
                      · Managed by {m.manager ?? "nobody yet"} ·{" "}
                      {m.teams ? "Posts to its Teams channel" : "No Teams channel"}
                    </p>
                    {m.enabled && (m.lastError || m.draftError) ? (
                      <p className="text-sm text-bad">{m.lastError ?? m.draftError}</p>
                    ) : null}
                  </div>
                  <Chip
                    tone={
                      !m.enabled
                        ? "neutral"
                        : m.lastError || m.draftError
                          ? "bad"
                          : m.lastSyncedAt
                            ? "good"
                            : "neutral"
                    }
                  >
                    {!m.enabled
                      ? "Off"
                      : m.lastError || m.draftError
                        ? "Problem"
                        : m.lastSyncedAt
                          ? `Checked ${timeAgo(m.lastSyncedAt)}`
                          : "Waiting"}
                  </Chip>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              None yet. Add each event&apos;s mailbox on its bot&apos;s Email step.
            </p>
          )}
          <details className="rounded-[10px] bg-muted px-3 py-2">
            <summary className="cursor-pointer text-sm font-semibold">
              How IT connects Microsoft 365 (once, for every event)
            </summary>
            <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5 text-sm">
              <li>
                In the Microsoft Entra admin centre, go to App registrations → New registration.
                Name it Billie, single tenant, no redirect address.
              </li>
              <li>
                In the new app, go to Certificates &amp; secrets → New client secret, and copy its
                value. Put the Directory (tenant) ID, the Application (client) ID and the secret in
                Vercel as <code>MS_TENANT_ID</code>, <code>MS_CLIENT_ID</code> and{" "}
                <code>MS_CLIENT_SECRET</code>, then redeploy. Note when the secret expires.
              </li>
              <li>
                Don&apos;t add Mail.ReadWrite under API permissions: that would open every mailbox
                in the company. Billie gets access to the event mailboxes only, in the next two
                steps.
              </li>
              <li>
                Make a mail-enabled security group, for example &ldquo;Billie event
                mailboxes&rdquo;, and add each event mailbox to it directly.
              </li>
              <li>
                In Exchange Online PowerShell (<code>Connect-ExchangeOnline</code>), run these. The
                object ID is the one on the Enterprise applications page, not App registrations.
                <pre className="mt-1.5 overflow-x-auto rounded-md bg-card p-2 text-xs">
                  {[
                    `New-ManagementScope -Name "Billie event mailboxes" -RecipientRestrictionFilter "MemberOfGroup -eq '<group distinguished name>'"`,
                    `New-ServicePrincipal -AppId <application ID> -ObjectId <object ID> -DisplayName "Billie"`,
                    `New-ManagementRoleAssignment -App <application ID> -Role "Application Mail.ReadWrite" -CustomResourceScope "Billie event mailboxes"`,
                    `Test-ServicePrincipalAuthorization -Identity <application ID> -Resource <an event mailbox>`,
                  ].join("\n")}
                </pre>
              </li>
              <li>
                Changes can take up to 2 hours to apply. Then use &ldquo;Check the mailbox&rdquo; on
                a bot&apos;s Email step. For a new event later, add its mailbox to the group.
              </li>
            </ol>
          </details>
        </Panel>
        <Panel className="flex flex-col gap-3">
          <h2 className="text-[1.05rem]">Addresses other services need</h2>
          {[
            {
              id: "wa-hook",
              label: "WhatsApp webhook (Meta → WhatsApp → Configuration)",
              url: `${base}/api/webhooks/whatsapp`,
            },
            {
              id: "na-hook",
              label: "Neon Auth sign-up check (Neon → Auth → Webhooks, event user.before_create)",
              url: `${base}/api/webhooks/neon-auth`,
            },
          ].map((h) => (
            <div key={h.id} className="flex flex-col gap-1">
              <p className="text-sm font-semibold">{h.label}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code id={h.id} className="break-all rounded-md bg-muted px-2 py-1 text-[0.85rem]">
                  {h.url}
                </code>
                <CopyButton text={h.url} selectId={h.id} />
              </div>
            </div>
          ))}
        </Panel>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Settings"
        lede="The team, privacy, alerts, connections and the AI. Admins only."
      />
      <TabsNav
        label="Settings sections"
        current={tab}
        tabs={[
          { key: "general", href: "/settings", label: "General" },
          { key: "team", href: "/settings?tab=team", label: "Team" },
          { key: "privacy", href: "/settings?tab=privacy", label: "Privacy requests" },
          { key: "connections", href: "/settings?tab=connections", label: "Connections" },
          { key: "ai", href: "/settings?tab=ai", label: "AI" },
        ]}
      />
      {body}
    </>
  );
}
