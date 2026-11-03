import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, query } from "@/lib/db/client";
import { botMembers, bots, knowledgeBases, passages, sources } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import type { Actor } from "@/lib/authz";
import { createBotKnowledgeBase } from "@/lib/knowledge/bases";
import { dateSnippet, findDates } from "@/lib/knowledge/dates";
import { addToBot } from "./people";
import { uniqueSlug } from "./slug";

/**
 * Copies a bot for the next show or edition: its look, personality, rules,
 * requests, test questions, people and all its knowledge (passages too, so
 * nothing is read or paid for again). Not copied: its websites, mailbox,
 * Teams channel and test results, which belong to the show. The copy is a
 * draft, and lists every date in it to check (datesToCheck).
 */
export async function copyBot(
  actor: Actor,
  fromId: string,
  next: { name: string; showName: string },
): Promise<string> {
  const from = await db.query.bots.findFirst({
    where: and(eq(bots.id, fromId), isNull(bots.deletedAt)),
  });
  if (!from) throw new UserError("That bot no longer exists.");
  const name = next.name.trim().slice(0, 60) || `${from.name} (copy)`;
  const taken = (await db.select({ slug: bots.slug }).from(bots)).map((r) => r.slug);

  return db.transaction(async (tx) => {
    const [bot] = await tx
      .insert(bots)
      .values({
        name,
        slug: uniqueSlug(name, taken),
        audience: from.audience,
        showName: next.showName.trim().slice(0, 80),
        color: from.color,
        avatarUrl: from.avatarUrl,
        welcome: from.welcome,
        starters: from.starters,
        tone: from.tone,
        personality: from.personality,
        emoji: from.emoji,
        emailSignOff: from.emailSignOff,
        quality: from.quality,
        // The setting comes across; the exhibitor list doesn't (each show has its own).
        personalAnswers: from.personalAnswers,
        status: "draft",
        rules: from.rules,
        tests: from.tests,
        requestTypes: from.requestTypes,
        copiedFromId: from.id,
        createdBy: actor.id,
      })
      .returning({ id: bots.id, name: bots.name });
    const kbId = await createBotKnowledgeBase(tx, bot, actor.id);

    // The same people, and whoever made the copy.
    const people = await tx
      .select({ userId: botMembers.userId })
      .from(botMembers)
      .where(eq(botMembers.botId, from.id));
    for (const p of people) await addToBot(tx, bot.id, p.userId, actor.id);
    await addToBot(tx, bot.id, actor.id, actor.id);

    // All its knowledge, passages and all.
    const own = await tx.query.knowledgeBases.findFirst({
      where: and(eq(knowledgeBases.botId, from.id), isNull(knowledgeBases.deletedAt)),
    });
    let copied = 0;
    if (own) {
      const list = await tx
        .select()
        .from(sources)
        .where(and(eq(sources.knowledgeBaseId, own.id), isNull(sources.deletedAt)))
        .orderBy(asc(sources.createdAt));
      for (const s of list) {
        const [made] = await tx
          .insert(sources)
          .values({
            knowledgeBaseId: kbId,
            title: s.title,
            kind: s.kind,
            status: s.status,
            error: s.error,
            fileName: s.fileName,
            fileKey: s.fileKey,
            fileSize: s.fileSize,
            mimeType: s.mimeType,
            url: s.url,
            refreshWeekly: s.refreshWeekly,
            body: s.body,
            contentHash: s.contentHash,
            chars: s.chars,
            passageCount: s.passageCount,
            lastReadAt: s.lastReadAt,
            addedBy: s.addedBy,
            createdAt: s.createdAt,
          })
          .returning({ id: sources.id });
        await tx.execute(
          sql`INSERT INTO ${passages} (source_id, knowledge_base_id, ordinal, text, label, embedding, created_at)
              SELECT ${made.id}, ${kbId}, ordinal, text, label, embedding, created_at
                FROM ${passages} WHERE source_id = ${s.id}`,
        );
        copied++;
      }
    }

    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: bot.id,
      action: "create",
      summary: `Copied "${from.name}" to "${bot.name}" (${copied} ${copied === 1 ? "source" : "sources"} of knowledge)`,
    });
    return bot.id;
  });
}

export type DateGroup = {
  /** A source of knowledge, or the bot's own words (welcome, starters, tests). */
  kind: "source" | "bot";
  id: string;
  title: string;
  sourceKind?: "file" | "text" | "qa" | "web";
  dates: { text: string; snippet: string }[];
};

const MAX_PER_GROUP = 12;

/** Every date in a copied bot, so the team can check each one for the new show. */
export async function datesToCheck(botId: string): Promise<DateGroup[]> {
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, botId) });
  if (!bot) return [];
  const groups: DateGroup[] = [];

  const own: { label: string; text: string }[] = [
    { label: "Show name", text: bot.showName },
    { label: "Welcome message", text: bot.welcome },
    ...bot.starters.map((s) => ({ label: "Suggested question", text: s })),
    ...bot.tests.map((t) => ({
      label: "Test question",
      text: `${t.question}${t.mustMention ? ` (must mention: ${t.mustMention})` : ""}`,
    })),
  ];
  const botDates = own.flatMap((o) =>
    findDates(o.text).map((d) => ({
      text: d.text,
      snippet: `${o.label}: ${dateSnippet(o.text, d)}`,
    })),
  );
  if (botDates.length)
    groups.push({
      kind: "bot",
      id: bot.id,
      title: "The bot's own words",
      dates: botDates.slice(0, MAX_PER_GROUP),
    });

  const rows = await query<{
    id: string;
    title: string;
    kind: DateGroup["sourceKind"];
    text: string;
  }>(
    db,
    sql`SELECT s.id, s.title, s.kind, string_agg(p.text, E'\\n\\n' ORDER BY p.ordinal) AS text
          FROM sources s
          JOIN knowledge_bases kb ON kb.id = s.knowledge_base_id
          JOIN passages p ON p.source_id = s.id
         WHERE kb.bot_id = ${botId} AND kb.deleted_at IS NULL AND s.deleted_at IS NULL
         GROUP BY s.id, s.title, s.kind, s.created_at
         ORDER BY s.created_at`,
  );
  for (const r of rows) {
    const seen = new Set<string>();
    const dates = findDates(r.text)
      .filter((d) => {
        const key = d.text.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((d) => ({ text: d.text, snippet: dateSnippet(r.text, d) }));
    if (dates.length)
      groups.push({
        kind: "source",
        id: r.id,
        title: r.title,
        sourceKind: r.kind,
        dates: dates.slice(0, MAX_PER_GROUP),
      });
  }
  return groups;
}

/** The team has checked the dates: the list goes away. */
export async function markDatesChecked(actor: Actor, botId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [bot] = await tx
      .update(bots)
      .set({ datesCheckedAt: new Date() })
      .where(and(eq(bots.id, botId), isNull(bots.deletedAt)))
      .returning({ name: bots.name });
    if (!bot) throw new UserError("That bot no longer exists.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "update",
      summary: `Checked the dates in "${bot.name}"`,
    });
  });
}
