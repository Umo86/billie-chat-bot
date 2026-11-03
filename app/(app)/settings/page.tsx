import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { Chip, PageHeader, Panel } from "@/components/ui/bits";
import { TabsNav } from "@/components/ui/tabs-nav";
import { CopyButton } from "@/components/ui/copy-button";
import { GeneralForm } from "@/components/settings/general-form";
import { Team } from "@/components/settings/team";
import { Privacy } from "@/components/settings/privacy";
import { requireActor } from "@/lib/auth/actor";
import { authMode } from "@/lib/auth/config";
import { getSettings } from "@/lib/settings";
import { botCards } from "@/lib/bots/queries";
import { openInvitations, teamMembers } from "@/lib/team/queries";
import { mailboxOverview } from "@/lib/emails/mailboxes";
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

type Tab = "general" | "team" | "privacy" | "connections";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor("settings.manage");
  const sp = await searchParams;
  const tab: Tab =
    sp.tab === "team" || sp.tab === "privacy" || sp.tab === "connections" ? sp.tab : "general";

  let body: React.ReactNode;
  if (tab === "general") {
    const [s, bots] = await Promise.all([getSettings(), botCards()]);
    body = (
      <GeneralForm
        bots={bots.map((b) => ({ id: b.id, name: b.name, audience: b.audience }))}
        initial={{
          companyName: s.companyName,
          retentionMonths: s.retentionMonths,
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
    const [members, invitations] = await Promise.all([teamMembers(), openInvitations()]);
    body = (
      <Team
        me={actor.id}
        members={members.map((m) => ({ ...m, linked: Boolean(m.linked) }))}
        invitations={invitations.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() }))}
      />
    );
  } else if (tab === "privacy") {
    const s = await getSettings();
    body = <Privacy retentionMonths={s.retentionMonths} />;
  } else {
    const base = appUrl();
    const dbUrl = appDatabaseUrl();
    const mailboxes = await mailboxOverview();
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
        name: "Teams (company-wide channel)",
        ok: teamsConfigured(),
        detail: teamsConfigured()
          ? "Connected. Chats from bots without their own channel are posted here."
          : "Optional. Each bot can post to its event's own channel (set on its Email step).",
        vars: "TEAMS_WEBHOOK_URL",
      },
    ];
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
                    {m.enabled && m.lastError ? (
                      <p className="text-sm text-bad">{m.lastError}</p>
                    ) : null}
                  </div>
                  <Chip
                    tone={
                      !m.enabled
                        ? "neutral"
                        : m.lastError
                          ? "bad"
                          : m.lastSyncedAt
                            ? "good"
                            : "neutral"
                    }
                  >
                    {!m.enabled
                      ? "Off"
                      : m.lastError
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
      <PageHeader title="Settings" lede="The team, privacy, alerts and connections. Admins only." />
      <TabsNav
        label="Settings sections"
        current={tab}
        tabs={[
          { key: "general", href: "/settings", label: "General" },
          { key: "team", href: "/settings?tab=team", label: "Team" },
          { key: "privacy", href: "/settings?tab=privacy", label: "Privacy requests" },
          { key: "connections", href: "/settings?tab=connections", label: "Connections" },
        ]}
      />
      {body}
    </>
  );
}
