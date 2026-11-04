import "server-only";
import { slackConfigured } from "@/lib/channels/slack";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/lib/db/client";
import { conversations, messages } from "@/lib/db/schema";
import { enqueue, PermanentJobError } from "@/lib/jobs/queue";
import { kickJobs } from "@/lib/jobs/kick";
import { AiError, structured } from "@/lib/ai/provider";
import { modelsFor } from "@/lib/ai/chosen";
import {
  knowledgeBlock,
  suggestReplySystem,
  suggestReplyUser,
  type PromptPassage,
  type Turn,
} from "@/lib/ai/prompts";
import { emailDraftJsonSchema, emailDraftSchema } from "@/lib/ai/schemas";
import { aiLimit, LIMIT_LINE, recordUsage } from "@/lib/ai/usage";
import { citeSources } from "@/lib/ai/answer";
import { answerBotFor, botById } from "@/lib/bots/load";
import { retrieve } from "@/lib/knowledge/search";
import { getSettings } from "@/lib/settings";
import { recordFor } from "@/lib/exhibitors/service";
import type { ReplySuggestion } from "@/lib/types";

/**
 * "Suggest a reply" in the Inbox: when a chat is handed to the team, Billie
 * drafts a reply from the bot's knowledge for the person to edit and send
 * (it is never sent by itself). Written on the job queue, as it's a Claude
 * call; the Inbox refreshes while it's writing.
 */

/** Marks the chat as waiting for a suggestion and queues the job (inside the caller's transaction). */
export async function queueSuggestion(tx: DbOrTx, conversationId: string): Promise<void> {
  const at = new Date();
  const writing: ReplySuggestion = {
    status: "writing",
    text: "",
    confident: false,
    missing: "",
    sources: [],
    afterMessageId: null,
    at: at.toISOString(),
  };
  await tx
    .update(conversations)
    .set({ suggestion: writing })
    .where(eq(conversations.id, conversationId));
  await enqueue(
    "suggest_reply",
    { conversationId },
    { tx, dedupeKey: `suggest:${conversationId}:${at.getTime()}`, maxAttempts: 2 },
  );
}

/** The "suggest_reply" job. */
export async function writeSuggestion(
  conversationId: string,
  opts: { lastTry?: boolean } = {},
): Promise<void> {
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conv) return;
  const bot = await botById(conv.botId);
  const save = (s: Omit<ReplySuggestion, "at">) =>
    db
      .update(conversations)
      .set({ suggestion: { ...s, at: new Date().toISOString() } })
      .where(eq(conversations.id, conversationId));
  if (!bot) return void (await save(failed("The bot was deleted.")));

  const rows = await db
    .select({ id: messages.id, role: messages.role, text: messages.text })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .limit(200);
  const history: Turn[] = rows.slice(-20).map((r) => ({ role: r.role, text: r.text }));
  const [lastAsked] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "visitor")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const asked = history
    .filter((t) => t.role === "visitor")
    .slice(-3)
    .map((t) => t.text)
    .join("\n");
  if (!asked.trim()) return void (await save(failed("They haven't asked anything yet.")));

  try {
    const limit = await aiLimit("staff");
    if (limit) return void (await save(failed(`${LIMIT_LINE[limit]}.`)));
    const answerBot = await answerBotFor(bot);
    const found = await retrieve(answerBot.knowledgeBaseIds, asked.slice(0, 4000));
    // A signed-in exhibitor's own row of the exhibitor list goes last.
    const record = answerBot.personal ? await recordFor(conv) : null;
    const passages: PromptPassage[] = record
      ? [
          ...found,
          {
            sourceId: "",
            sourceTitle: "Their exhibitor record",
            label: "",
            text: record,
            kind: "text",
          },
        ]
      : found;
    const call = {
      purpose: "reply_suggestion" as const,
      system: suggestReplySystem({
        name: bot.name,
        audience: bot.audience,
        showName: bot.showName,
        tone: bot.tone,
        personality: bot.personality,
        emoji: false,
        alwaysHuman: bot.rules.alwaysHuman,
      }),
      knowledge: knowledgeBlock(passages),
      user: suggestReplyUser(history, new Date(), record ? passages.length : undefined),
      schema: emailDraftJsonSchema,
      maxTokens: 800,
      fake: { purpose: "reply_suggestion" as const, history, passages },
    };
    // As with answers: Thorough bots try the Fast model first (Settings → AI).
    const plan =
      bot.quality === "thorough" && (await getSettings()).tryFastFirst
        ? [await modelsFor("fast"), await modelsFor("thorough")]
        : [await modelsFor(bot.quality)];
    let d: ReturnType<typeof emailDraftSchema.parse> | null = null;
    for (let i = 0; i < plan.length; i++) {
      const last = i === plan.length - 1;
      let result;
      try {
        result = await structured({ ...call, ...plan[i] });
      } catch (err) {
        if (!last && err instanceof AiError && err.code !== "refused") continue;
        throw err;
      }
      await recordUsage("suggestion", result.usage, result.model);
      const parsed = emailDraftSchema.safeParse(result.json);
      if (!parsed.success) {
        if (!last) continue;
        throw new AiError("invalid_output", "The suggestion didn't match the expected shape");
      }
      d = parsed.data;
      if ((d.confident && d.draft.trim()) || last) break;
    }
    if (!d) throw new AiError("invalid_output", "No suggestion");
    const draft = d.draft.trim();
    const confident = d.confident && Boolean(draft);
    const text = confident ? draft : d.holding.trim() || draft;
    await save({
      status: text ? "ready" : "none",
      text,
      confident,
      missing: d.missing.trim().slice(0, 300),
      sources: confident
        ? citeSources(d.used, passages).map((s) => ({ title: s.title, label: s.label }))
        : [],
      afterMessageId: lastAsked?.id ?? null,
    });
    // In Slack, the chat's thread gets it too, to copy into a reply.
    if (text && slackConfigured())
      await enqueue(
        "slack_note",
        {
          conversationId,
          text: `Billie suggests${confident ? "" : " a holding reply"}: ${text}`,
        },
        { dedupeKey: `slack-suggest:${conversationId}:${lastAsked?.id ?? "none"}`, once: true },
      );
  } catch (err) {
    if (err instanceof AiError && err.code === "not_configured") {
      await save(failed("Claude isn't connected yet."));
      return;
    }
    if (opts.lastTry || err instanceof PermanentJobError) {
      await save(failed("Billie couldn't write a suggestion. Try again."));
      return;
    }
    throw err; // tried again
  }
}

function failed(error: string): Omit<ReplySuggestion, "at"> {
  return {
    status: "failed",
    text: "",
    confident: false,
    missing: "",
    sources: [],
    afterMessageId: null,
    error,
  };
}

/** "Suggest again" from the Inbox. */
export async function askForSuggestion(conversationId: string): Promise<void> {
  await db.transaction((tx) => queueSuggestion(tx, conversationId));
  await kickJobs();
}
