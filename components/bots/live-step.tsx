"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, Globe, Mail, MessageCircle, Power, Rocket, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Note, Panel } from "@/components/ui/bits";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/form";
import { CopyButton } from "@/components/ui/copy-button";
import { useRunner } from "@/components/ui/use-runner";
import {
  deleteBotAction,
  restoreBotAction,
  setBotStatusAction,
  updateBotAction,
} from "@/app/actions/bots";
import type { TestRun } from "@/lib/types";

export function LiveStep({
  bot,
  appUrl,
  qrSvg,
  channels,
  can,
}: {
  bot: {
    id: string;
    name: string;
    slug: string;
    status: "draft" | "live";
    domains: string[];
    audience: "visitors" | "exhibitors";
    lastTestRun: TestRun | null;
  };
  appUrl: string;
  qrSvg: string;
  channels: { whatsapp: boolean; outlook: boolean };
  can: { edit: boolean; publish: boolean; delete: boolean };
}) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = useRunner();
  const del = useRunner();
  const tested = Boolean(bot.lastTestRun?.total);
  const hosted = `${appUrl}/c/${bot.slug}`;
  const embed = `<script src="${appUrl}/widget.js" data-bot="${bot.slug}" async></script>`;

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[1.05rem]">Status</h2>
            <Chip tone={bot.status === "live" ? "good" : "neutral"}>
              {bot.status === "live" ? "Live" : "Draft"}
            </Chip>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {bot.status === "live"
              ? "Answering on your websites, the chat link and WhatsApp."
              : tested
                ? `Last test: ${bot.lastTestRun!.passed} of ${bot.lastTestRun!.total} passed. Put it live when you're happy.`
                : "Run the test questions (step 4) before putting it live."}
          </p>
        </div>
        {can.publish ? (
          bot.status === "live" ? (
            <Button
              variant="danger"
              disabled={status.pending}
              onClick={() =>
                status.run(() => setBotStatusAction({ id: bot.id, status: "draft" }), {
                  done: () =>
                    toast.success(`${bot.name} is back in draft. It has stopped answering.`),
                })
              }
            >
              <Power /> Take offline
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={status.pending || !tested}
              onClick={() =>
                status.run(() => setBotStatusAction({ id: bot.id, status: "live" }), {
                  done: () => toast.success(`${bot.name} is live.`),
                })
              }
            >
              <Rocket /> Put live
            </Button>
          )
        ) : null}
      </Panel>

      <Panel className="flex flex-col gap-3">
        <div>
          <h2 className="text-[1.05rem]">Add it to a website</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Paste this just before <code>&lt;/body&gt;</code> on every page that should show the
            chat button, or send it to whoever looks after the website.
          </p>
        </div>
        <pre
          id="embed-code"
          className="overflow-x-auto rounded-[10px] bg-muted px-3 py-2.5 font-mono text-[0.85rem]"
        >
          {embed}
        </pre>
        <div>
          <CopyButton text={embed} label="Copy code" selectId="embed-code" />
        </div>
        <DomainsEditor
          key={bot.domains.join("\n")}
          botId={bot.id}
          saved={bot.domains}
          canEdit={can.edit}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel className="flex flex-col gap-3">
          <h2 className="text-[1.05rem]">Chat link and QR code</h2>
          <p className="text-sm text-muted-foreground">
            A page with just the chat, for emails, the exhibitor portal or posters at the show.
          </p>
          <p className="break-all font-mono text-[0.88rem]" id="hosted-link">
            {hosted}
          </p>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={hosted} label="Copy link" selectId="hosted-link" />
            <Button asChild size="sm">
              <a href={hosted} target="_blank" rel="noreferrer">
                <ExternalLink /> Open
              </a>
            </Button>
          </div>
          <div
            className="w-40 rounded-[10px] bg-white p-2"
            role="img"
            aria-label={`QR code for ${hosted}`}
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        </Panel>
        <Panel className="flex flex-col gap-3">
          <h2 className="text-[1.05rem]">Other channels</h2>
          <div className="flex items-start gap-3">
            <MessageCircle className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <p className="text-sm">
              <strong>WhatsApp.</strong>{" "}
              {channels.whatsapp
                ? `Connected. People who message the show's WhatsApp number are asked whether they're visiting or exhibiting, then this bot answers ${bot.audience}.`
                : "Not connected yet. An admin can connect the show's WhatsApp number in Settings."}
            </p>
          </div>
          <div className="flex items-start gap-3">
            <Mail className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <p className="text-sm">
              <strong>Exhibitor mailbox.</strong>{" "}
              {channels.outlook
                ? "Connected. New emails get a draft reply from the exhibitor knowledge, ready to check in Emails."
                : "Not connected yet. Until it is, paste emails into Emails to get a draft reply."}
            </p>
          </div>
        </Panel>
      </div>

      {can.delete ? (
        <Panel className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[1.05rem]">Delete this bot</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              It stops answering everywhere. Its chats are kept, and you can undo this for 30 days.
            </p>
          </div>
          <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogTrigger asChild>
              <Button variant="danger">
                <Trash2 /> Delete bot
              </Button>
            </DialogTrigger>
            <DialogContent title={`Delete ${bot.name}?`}>
              <Note tone="warn">
                The embed code and chat link stop working straight away. You can restore it from the
                message that appears.
              </Note>
              <div className="flex justify-end gap-2">
                <DialogClose asChild>
                  <Button>Keep it</Button>
                </DialogClose>
                <Button
                  variant="dangerSolid"
                  disabled={del.pending}
                  onClick={() =>
                    del.run(() => deleteBotAction({ id: bot.id }), {
                      done: () => {
                        setConfirmDelete(false);
                        router.push("/");
                        toast(`Deleted ${bot.name}.`, {
                          action: {
                            label: "Undo",
                            onClick: async () => {
                              const r = await restoreBotAction({ id: bot.id });
                              if (r.ok) router.push(`/bots/${bot.id}?step=live`);
                              else toast.error(r.error);
                            },
                          },
                        });
                      },
                    })
                  }
                >
                  Delete
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </Panel>
      ) : null}
    </div>
  );
}

/** Keyed on the saved list, so it shows the tidied addresses after saving. */
function DomainsEditor({
  botId,
  saved,
  canEdit,
}: {
  botId: string;
  saved: string[];
  canEdit: boolean;
}) {
  const [domains, setDomains] = useState(saved.join("\n"));
  const saveDomains = useRunner();
  const bot = { id: botId, domains: saved };
  const can = { edit: canEdit };
  return (
    <>
      <Field
        id="domains"
        label="Websites allowed to show it"
        hint="One per line, e.g. ukconstructionweek.com (its subdomains are included). The chat button only appears on these websites, so copied code can't be used elsewhere."
      >
        <Textarea
          id="domains"
          value={domains}
          disabled={!can.edit}
          onChange={(e) => setDomains(e.target.value)}
          className="min-h-20 font-mono text-[0.9rem]"
          placeholder={"ukconstructionweek.com\nexhibitors.ukconstructionweek.com"}
        />
      </Field>
      {!bot.domains.length ? (
        <Note tone="warn">
          Add the website first: until then the chat button won&apos;t appear on any site. The chat
          link below works either way.
        </Note>
      ) : null}
      {can.edit ? (
        <div>
          <Button
            disabled={saveDomains.pending}
            onClick={() =>
              saveDomains.run(() =>
                updateBotAction({
                  id: bot.id,
                  domains: domains
                    .split(/[\n,]/)
                    .map((d) => d.trim())
                    .filter(Boolean),
                }),
              )
            }
          >
            <Globe /> Save websites
          </Button>
        </div>
      ) : null}
    </>
  );
}
