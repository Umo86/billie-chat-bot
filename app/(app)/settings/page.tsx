import type { Metadata } from "next";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { PageHeader, Panel } from "@/components/ui/bits";
import { TabsNav } from "@/components/ui/tabs-nav";
import { CopyButton } from "@/components/ui/copy-button";
import { GeneralForm } from "@/components/settings/general-form";
import { Team } from "@/components/settings/team";
import { requireActor } from "@/lib/auth/actor";
import { authMode } from "@/lib/auth/config";
import { getSettings } from "@/lib/settings";
import { botCards } from "@/lib/bots/queries";
import { openInvitations, teamMembers } from "@/lib/team/queries";
import {
  aiProvider,
  appUrl,
  blobConfigured,
  embeddingsProvider,
  emailConfigured,
  outlookConfigured,
  teamsConfigured,
  whatsappConfigured,
} from "@/lib/config";
import { appDatabaseUrl, describeDatabase, isNeon } from "@/lib/db/urls";

export const metadata: Metadata = { title: "Settings" };

type Tab = "general" | "team" | "connections";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor("settings.manage");
  const sp = await searchParams;
  const tab: Tab = sp.tab === "team" || sp.tab === "connections" ? sp.tab : "general";

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
  } else {
    const base = appUrl();
    const dbUrl = appDatabaseUrl();
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
        name: "Exhibitor mailbox (Outlook)",
        ok: outlookConfigured(),
        detail: outlookConfigured() ? "Connected" : "Paste emails until connected",
        vars: "MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_MAILBOX",
      },
      {
        name: "WhatsApp",
        ok: whatsappConfigured(),
        detail: whatsappConfigured() ? "Connected" : "Not set up",
        vars: "WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN",
      },
      {
        name: "Microsoft Teams alerts",
        ok: teamsConfigured(),
        detail: teamsConfigured() ? "Connected" : "Not set up",
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
          { key: "connections", href: "/settings?tab=connections", label: "Connections" },
        ]}
      />
      {body}
    </>
  );
}
