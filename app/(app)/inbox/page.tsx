import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Globe, MessageCircle, Smartphone } from "lucide-react";
import { Chip, EmptyState, PageHeader } from "@/components/ui/bits";
import { TabsNav } from "@/components/ui/tabs-nav";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { Availability } from "@/components/inbox/availability";
import { ConversationView } from "@/components/inbox/conversation-view";
import { requireActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import {
  conversationDetail,
  inboxCounts,
  inboxList,
  type InboxTab,
} from "@/lib/conversations/inbox";
import { agentsAvailable, extendIfAvailable, isAvailable } from "@/lib/conversations/presence";
import { markRead } from "@/lib/conversations/service";
import { knowledgeBaseIdsFor } from "@/lib/bots/load";
import { knowledgeBaseList } from "@/lib/knowledge/queries";
import { withinReplyWindow } from "@/lib/channels/whatsapp";
import { timeAgo } from "@/lib/time";
import type { ContactDetails } from "@/lib/types";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Inbox" };

const TABS: { key: InboxTab; label: string }[] = [
  { key: "needs", label: "Needs you" },
  { key: "live", label: "Live" },
  { key: "billie", label: "With Billie" },
  { key: "done", label: "Finished" },
];

function replyHint(
  status: string,
  channel: string,
  contact: ContactDetails,
  lastVisitorAt: Date | null,
): string | null {
  if (channel === "whatsapp")
    return withinReplyWindow(lastVisitorAt, new Date())
      ? "Your reply is sent to them on WhatsApp."
      : "WhatsApp only allows replies within 24 hours of their last message. Call or email them instead.";
  if (status === "ticket" || status === "replied")
    return contact.email
      ? `They've left the chat, so your reply is emailed to ${contact.email}.`
      : contact.phone
        ? `They left no email. Call them on ${contact.phone}.`
        : null;
  if (status === "bot") return "Replying takes this chat over from Billie.";
  return "They see your reply in the chat straight away.";
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor("inbox.view");
  const sp = await searchParams;
  const tab: InboxTab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as InboxTab) : "needs";
  await extendIfAvailable(actor.id);
  const [rows, counts, mine, others] = await Promise.all([
    inboxList(tab),
    inboxCounts(),
    isAvailable(actor.id),
    agentsAvailable(),
  ]);
  const picked = sp.c && /^[0-9a-f-]{36}$/i.test(sp.c) ? sp.c : null;
  const selectedId = picked ?? rows[0]?.id ?? null;
  const detail = selectedId ? await conversationDetail(selectedId) : null;
  if (detail) await markRead(detail.conversation.id);
  const canTeach = can(actor, "knowledge.edit");
  const kbs =
    detail && canTeach
      ? await (async () => {
          const [all, own] = await Promise.all([
            knowledgeBaseList(),
            knowledgeBaseIdsFor(detail.conversation.botId),
          ]);
          const preferred = all.filter((k) => own.includes(k.id));
          return (preferred.length ? preferred : all).map((k) => ({ id: k.id, name: k.name }));
        })()
      : [];
  const live = counts.needs + counts.live > 0;

  return (
    <>
      <AutoRefresh active every={live || mine ? 4000 : 10000} />
      <PageHeader
        title="Inbox"
        lede="Chats that need a person. Reply here and it reaches them in the chat, on WhatsApp, or by email if they've gone."
        actions={<Availability available={mine} others={Math.max(0, others - (mine ? 1 : 0))} />}
      />
      <TabsNav
        label="Inbox sections"
        current={tab}
        tabs={TABS.map((t) => ({
          key: t.key,
          href: `/inbox?tab=${t.key}`,
          label:
            (t.key === "needs" || t.key === "live") && counts[t.key]
              ? `${t.label} (${counts[t.key]})`
              : t.label,
        }))}
      />
      {!rows.length && !detail ? (
        <EmptyState title={tab === "needs" ? "Nothing needs you right now" : "No chats here"}>
          {tab === "needs"
            ? "When someone asks for a person, or Billie can't help, the chat appears here. Switch on “available” to take live chats."
            : "Chats will show here as they happen."}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <ul
            aria-label="Chats"
            className={cn("flex flex-col gap-1.5", picked && "hidden lg:flex")}
          >
            {rows.map((r) => {
              const Icon =
                r.channel === "whatsapp"
                  ? Smartphone
                  : r.channel === "hosted"
                    ? MessageCircle
                    : Globe;
              return (
                <li key={r.id}>
                  <Link
                    href={`/inbox?tab=${tab}&c=${r.id}`}
                    aria-current={r.id === selectedId ? "page" : undefined}
                    data-testid="inbox-row"
                    className={cn(
                      "flex flex-col gap-1 rounded-[12px] border border-border bg-card px-3.5 py-3 hover:border-primary/50",
                      r.id === selectedId && "border-primary bg-accent",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {r.unread ? (
                        <span
                          className="size-2 shrink-0 rounded-full bg-signal"
                          aria-label="New messages"
                        />
                      ) : null}
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-semibold">
                        {r.contact.name || (r.waId ? `+${r.waId}` : "Visitor")}
                        {r.contact.company ? ` · ${r.contact.company}` : ""}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {timeAgo(r.lastMessageAt)}
                      </span>
                    </span>
                    {r.firstQuestion ? (
                      <span className="line-clamp-1 text-sm">&ldquo;{r.firstQuestion}&rdquo;</span>
                    ) : null}
                    {r.lastText && r.lastText !== r.firstQuestion ? (
                      <span className="line-clamp-1 text-sm text-muted-foreground">
                        {r.lastText}
                      </span>
                    ) : null}
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Chip
                        className="h-5 text-[0.7rem]"
                        tone={
                          r.status === "waiting" || r.status === "ticket"
                            ? "warn"
                            : r.status === "live"
                              ? "good"
                              : "neutral"
                        }
                      >
                        {r.status === "waiting"
                          ? "Waiting"
                          : r.status === "ticket"
                            ? "Needs a reply"
                            : r.status === "live"
                              ? "Live"
                              : r.status === "collecting"
                                ? "Taking details"
                                : r.status === "bot"
                                  ? "Billie"
                                  : r.status === "replied"
                                    ? "Replied"
                                    : "Closed"}
                      </Chip>
                      <span className="text-xs text-muted-foreground">{r.botName}</span>
                      {r.channel === "try" ? <Chip className="h-5 text-[0.7rem]">TEST</Chip> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {detail ? (
            <div className="flex min-w-0 flex-col gap-2">
              {picked ? (
                <Link
                  href={`/inbox?tab=${tab}`}
                  className="inline-flex items-center gap-1 text-sm font-semibold text-primary lg:hidden"
                >
                  <ArrowLeft className="size-4" aria-hidden /> All chats
                </Link>
              ) : null}
              <ConversationView
                key={detail.conversation.id}
                id={detail.conversation.id}
                status={detail.conversation.status}
                channel={detail.conversation.channel}
                botName={detail.bot?.name ?? "Billie"}
                contact={detail.conversation.contact as ContactDetails}
                waId={detail.conversation.waId}
                pageUrl={detail.conversation.pageUrl}
                assignedName={detail.assignedName}
                lines={detail.lines}
                kbs={kbs}
                canTeach={canTeach}
                replyHint={replyHint(
                  detail.conversation.status,
                  detail.conversation.channel,
                  detail.conversation.contact as ContactDetails,
                  detail.conversation.lastVisitorAt,
                )}
              />
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
