import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { emailThreads } from "@/lib/db/schema";
import { AiError, structured } from "@/lib/ai/provider";
import {
  emailDraftJsonSchema,
  emailDraftSchema,
  emailTagJsonSchema,
  emailTagSchema,
} from "@/lib/ai/schemas";
import {
  emailDraftSystem,
  emailDraftUser,
  emailTagSystem,
  emailTagUser,
  knowledgeBlock,
} from "@/lib/ai/prompts";
import { fallbackFor, modelFor } from "@/lib/ai/models";
import { citeSources } from "@/lib/ai/answer";
import { capReached, recordUsage } from "@/lib/ai/usage";
import { answerBotFor, botById } from "@/lib/bots/load";
import { ALWAYS_HUMAN_DEFAULT } from "@/lib/bots/defaults";
import { retrieve } from "@/lib/knowledge/search";
import { recordGap } from "@/lib/knowledge/gap-store";
import { getSettings } from "@/lib/settings";
import { PermanentJobError } from "@/lib/jobs/queue";
import { createReplyDraft, setCategories } from "@/lib/channels/outlook";
import { outlookConfigured } from "@/lib/config";

/**
 * The email assistant (the "process_email" job). Two checks before any
 * draft: a fast model tags the email and spots always-human topics; then a
 * thorough model drafts the reply from the knowledge base. A person checks
 * and sends every draft. Outlook emails get the draft in their own thread
 * and Outlook categories; pasted emails show the draft in Billie.
 */
export async function processEmail(emailId: string): Promise<void> {
  const email = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, emailId) });
  if (!email) throw new PermanentJobError("Email not found");
  if (["sent", "dismissed"].includes(email.status)) return;
  await db
    .update(emailThreads)
    .set({ status: "working", error: null })
    .where(eq(emailThreads.id, emailId));

  try {
    if (await capReached())
      throw new AiError("cap_reached", "Today's answer limit has been reached");
    const settings = await getSettings();
    const bot = email.botId
      ? await botById(email.botId)
      : settings.emailBotId
        ? await botById(settings.emailBotId)
        : null;
    const alwaysHuman = bot?.rules.alwaysHuman ?? ALWAYS_HUMAN_DEFAULT;
    const show = bot?.showName ?? "";
    const prompt = {
      fromName: email.fromName,
      fromEmail: email.fromEmail,
      subject: email.subject,
      body: email.body,
    };

    const tagged = await structured({
      purpose: "email_tag",
      model: modelFor("fast"),
      fallbackModel: fallbackFor("fast"),
      system: emailTagSystem(show, alwaysHuman),
      user: emailTagUser(prompt),
      schema: emailTagJsonSchema,
      maxTokens: 400,
      fake: { purpose: "email_tag", email: prompt, alwaysHuman },
    });
    await recordUsage("email", tagged.usage);
    const tag = emailTagSchema.parse(tagged.json);
    const tags = {
      topic: tag.topic,
      company: tag.company.trim().slice(0, 80) || null,
      stand: tag.stand.trim().slice(0, 30) || null,
      urgency: tag.urgency,
    };

    if (tag.always_human) {
      await db
        .update(emailThreads)
        .set({
          status: "needs_you",
          tags,
          summary: tag.summary.slice(0, 300),
          needsYouReason: "This topic always goes to a person.",
          draft: "",
          draftSources: [],
          botId: bot?.id ?? null,
        })
        .where(eq(emailThreads.id, emailId));
      await tagInOutlook(email.source, email.externalId, ["Billie: needs you", tag.topic]);
      return;
    }

    const kbIds = bot ? (await answerBotFor(bot)).knowledgeBaseIds : [];
    const passages = await retrieve(kbIds, `${email.subject}\n${email.body}`.slice(0, 4000));
    const drafted = await structured({
      purpose: "email_draft",
      model: modelFor("thorough"),
      fallbackModel: fallbackFor("thorough"),
      system: emailDraftSystem({
        show,
        tone: bot?.tone ?? "friendly",
        signature: settings.emailSignature,
      }),
      knowledge: knowledgeBlock(passages),
      user: emailDraftUser(prompt),
      schema: emailDraftJsonSchema,
      maxTokens: 1500,
      fake: { purpose: "email_draft", email: prompt, passages, signature: settings.emailSignature },
    });
    await recordUsage("email", drafted.usage);
    const d = emailDraftSchema.parse(drafted.json);
    const draft = d.draft.trim();
    const ok = d.confident && Boolean(draft);
    if (!ok && bot) await recordGap(bot.id, d.missing.trim() || email.subject);

    const text = ok ? draft : d.holding.trim() || draft;
    let outlookDraftId: string | null = null;
    if (email.source === "outlook" && email.externalId && outlookConfigured() && text) {
      outlookDraftId = await createReplyDraft(email.externalId, text);
    }
    await db
      .update(emailThreads)
      .set({
        status: ok ? "draft_ready" : "needs_you",
        tags,
        summary: tag.summary.slice(0, 300),
        needsYouReason: ok
          ? null
          : d.missing.trim()
            ? `Not in the knowledge base: ${d.missing.trim().slice(0, 300)}`
            : "Billie wasn't sure of the answer.",
        draft: text,
        draftSources: ok ? citeSources(d.used, passages) : [],
        outlookDraftId,
        botId: bot?.id ?? null,
      })
      .where(eq(emailThreads.id, emailId));
    await tagInOutlook(email.source, email.externalId, [
      ok ? "Billie: draft ready" : "Billie: needs you",
      tag.topic,
    ]);
  } catch (err) {
    const message =
      err instanceof AiError && err.code === "not_configured"
        ? "Claude isn't connected (ANTHROPIC_API_KEY)."
        : err instanceof AiError && err.code === "cap_reached"
          ? "Today's answer limit was reached. Billie will try again later."
          : "Billie couldn't draft this one. It will try again.";
    await db
      .update(emailThreads)
      .set({ status: "failed", error: message })
      .where(eq(emailThreads.id, emailId));
    if (err instanceof AiError && err.code === "not_configured") return;
    throw err;
  }
}

async function tagInOutlook(source: string, externalId: string | null, categories: string[]) {
  if (source !== "outlook" || !externalId || !outlookConfigured()) return;
  await setCategories(externalId, categories).catch((err) =>
    console.warn("categories not set", err instanceof Error ? err.message : err),
  );
}
