import "server-only";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { bots, conversations, messages, users } from "@/lib/db/schema";
import type { ContactDetails } from "@/lib/types";
import type { ConversationStatus } from "./status";

/** The Inbox: chats that need a person, live chats, Billie's chats and finished ones. */
export type InboxTab = "needs" | "live" | "billie" | "done";

export const TAB_STATUSES: Record<InboxTab, ConversationStatus[]> = {
  needs: ["waiting", "ticket"],
  live: ["live", "collecting"],
  billie: ["bot"],
  done: ["replied", "closed"],
};

export type InboxRow = {
  id: string;
  status: ConversationStatus;
  channel: "web" | "hosted" | "whatsapp" | "try";
  botName: string;
  botColor: string;
  contact: ContactDetails;
  waId: string | null;
  firstQuestion: string;
  lastText: string;
  lastMessageAt: string;
  unread: boolean;
  assignedName: string | null;
  handoverReason: string | null;
};

export async function inboxList(tab: InboxTab): Promise<InboxRow[]> {
  const statuses = TAB_STATUSES[tab];
  const since = tab === "billie" ? "7 days" : tab === "done" ? "30 days" : "365 days";
  const rows = await query<{
    id: string;
    status: ConversationStatus;
    channel: InboxRow["channel"];
    bot_name: string;
    bot_color: string;
    contact: ContactDetails;
    wa_id: string | null;
    first_question: string;
    last_text: string;
    last_message_at: Date;
    unread: boolean;
    assigned_name: string | null;
    handover_reason: string | null;
  }>(
    db,
    sql`SELECT c.id, c.status, c.channel, b.name AS bot_name, b.color AS bot_color, c.contact, c.wa_id,
               c.first_question, c.last_text, c.last_message_at, c.handover_reason,
               (c.last_visitor_at IS NOT NULL AND (c.staff_read_at IS NULL OR c.last_visitor_at > c.staff_read_at)) AS unread,
               u.full_name AS assigned_name
        FROM conversations c
        JOIN bots b ON b.id = c.bot_id
        LEFT JOIN users u ON u.id = c.assigned_to
        WHERE c.status = ANY(${sql.raw(`ARRAY[${statuses.map((s) => `'${s}'`).join(",")}]::conversation_status[]`)})
          AND c.last_message_at > now() - ${sql.raw(`interval '${since}'`)}
        ORDER BY ${tab === "needs" ? sql`c.status = 'waiting' DESC, c.last_message_at ASC` : sql`c.last_message_at DESC`}
        LIMIT 200`,
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    channel: r.channel,
    botName: r.bot_name,
    botColor: r.bot_color,
    contact: r.contact ?? {},
    waId: r.wa_id,
    firstQuestion: r.first_question,
    lastText: r.last_text,
    lastMessageAt: new Date(r.last_message_at).toISOString(),
    unread: r.unread,
    assignedName: r.assigned_name,
    handoverReason: r.handover_reason,
  }));
}

export async function inboxCounts(): Promise<Record<InboxTab, number>> {
  const rows = await query<{ status: ConversationStatus; n: number }>(
    db,
    sql`SELECT status, count(*)::int AS n FROM conversations
        WHERE status IN ('waiting','ticket','live','collecting') GROUP BY status`,
  );
  const n = (s: ConversationStatus) => rows.find((r) => r.status === s)?.n ?? 0;
  return { needs: n("waiting") + n("ticket"), live: n("live") + n("collecting"), billie: 0, done: 0 };
}

export type TranscriptLine = {
  id: string;
  role: "visitor" | "bot" | "agent" | "system";
  text: string;
  author: string | null;
  sources: { title: string; label: string }[];
  rating: number | null;
  createdAt: string;
};

export async function conversationDetail(id: string) {
  const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
  if (!conv) return null;
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, conv.botId),
    columns: { id: true, name: true, color: true, avatarUrl: true, slug: true },
  });
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt))
    .limit(1000);
  const authorIds = [...new Set(rows.map((r) => r.authorId).filter((x): x is string => !!x))];
  const authors = authorIds.length
    ? await db
        .select({ id: users.id, name: users.fullName })
        .from(users)
        .where(inArray(users.id, authorIds))
    : [];
  const names = new Map(authors.map((a) => [a.id, a.name]));
  const assigned = conv.assignedTo
    ? await db.query.users.findFirst({
        where: eq(users.id, conv.assignedTo),
        columns: { fullName: true },
      })
    : null;
  return {
    conversation: conv,
    bot,
    assignedName: assigned?.fullName ?? null,
    lines: rows.map(
      (m): TranscriptLine => ({
        id: m.id,
        role: m.role,
        text: m.text,
        author: m.authorId ? (names.get(m.authorId) ?? null) : null,
        sources: (m.sources as { title: string; label: string }[]).map((s) => ({
          title: s.title,
          label: s.label,
        })),
        rating: m.rating,
        createdAt: m.createdAt.toISOString(),
      }),
    ),
  };
}

/** Plain-text transcript for the Export button. */
export function transcriptText(
  d: NonNullable<Awaited<ReturnType<typeof conversationDetail>>>,
): string {
  const c = d.conversation;
  const contact = c.contact as ContactDetails;
  const head = [
    `Chat with ${d.bot?.name ?? "a bot"} (${c.channel})`,
    `Started: ${c.createdAt.toISOString()}`,
    contact.name ? `Name: ${contact.name}` : null,
    contact.company ? `Company: ${contact.company}` : null,
    contact.stand ? `Stand: ${contact.stand}` : null,
    contact.email ? `Email: ${contact.email}` : null,
    contact.phone ? `Phone: ${contact.phone}` : null,
    c.waId ? `WhatsApp: +${c.waId}` : null,
    c.pageUrl ? `Page: ${c.pageUrl}` : null,
  ].filter(Boolean);
  const who = (l: TranscriptLine) =>
    l.role === "visitor"
      ? "Visitor"
      : l.role === "bot"
        ? (d.bot?.name ?? "Billie")
        : l.role === "agent"
          ? (l.author ?? "Team")
          : "Note";
  const body = d.lines.map((l) => `[${l.createdAt}] ${who(l)}: ${l.text}`);
  return `${head.join("\n")}\n\n${body.join("\n\n")}\n`;
}
