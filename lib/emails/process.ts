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
import { modelsFor } from "@/lib/ai/chosen";
import { citeSources } from "@/lib/ai/answer";
import { capReached, recordUsage } from "@/lib/ai/usage";
import { answerBotFor, botById } from "@/lib/bots/load";
import { ALWAYS_HUMAN_DEFAULT } from "@/lib/bots/defaults";
import { retrieve } from "@/lib/knowledge/search";
import { recordGap } from "@/lib/knowledge/gap-store";
import { getSettings } from "@/lib/settings";
import { enqueue, PermanentJobError } from "@/lib/jobs/queue";

/**
 * The email assistant (the "process_email" job). Two checks before any
 * draft: a fast model tags the email and spots always-human topics; then a
 * thorough model drafts the reply from the bot's knowledge, in the bot's
 * personality and with its sign-off. A person checks and sends every draft.
 *
 * Emails from an event mailbox then go to the "deliver_email_draft" job,
 * which saves the reply in the mailbox's Drafts and posts in the event's
 * Teams channel. Kept apart so a retry never pays for the drafting twice.
 */
export async function processEmail(emailId: string, opts: { redo?: boolean } = {}): Promise<void> {
  const email = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, emailId) });
  if (!email) throw new PermanentJobError("Email not found");
  if (["sent", "dismissed"].includes(email.status)) return;
  // A person asked for a new draft: it replaces Billie's old one in Outlook, without a new post.
  const deliver = () =>
    email.source === "outlook"
      ? enqueue("deliver_email_draft", { emailId, ...(opts.redo ? { quiet: true } : {}) })
      : Promise.resolve(null);
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
      ...(await modelsFor("fast")),
      system: emailTagSystem(show, alwaysHuman),
      user: emailTagUser(prompt),
      schema: emailTagJsonSchema,
      maxTokens: 400,
      fake: { purpose: "email_tag", email: prompt, alwaysHuman },
    });
    await recordUsage("email", tagged.usage, tagged.model);
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
      await deliver();
      return;
    }

    const kbIds = bot ? (await answerBotFor(bot)).knowledgeBaseIds : [];
    const passages = await retrieve(kbIds, `${email.subject}\n${email.body}`.slice(0, 4000));
    // The bot's own sign-off, else the company's in Settings.
    const signature = (bot?.emailSignOff.trim() || settings.emailSignature).trim();
    const drafted = await structured({
      purpose: "email_draft",
      ...(await modelsFor("thorough")),
      system: emailDraftSystem({
        show,
        tone: bot?.tone ?? "friendly",
        personality: bot?.personality ?? "",
      }),
      knowledge: knowledgeBlock(passages),
      user: emailDraftUser(prompt),
      schema: emailDraftJsonSchema,
      maxTokens: 1500,
      fake: { purpose: "email_draft", email: prompt, passages },
    });
    await recordUsage("email", drafted.usage, drafted.model);
    const d = emailDraftSchema.parse(drafted.json);
    const draft = d.draft.trim();
    const ok = d.confident && Boolean(draft);
    if (!ok && bot) await recordGap(bot.id, d.missing.trim() || email.subject);

    const body = ok ? draft : d.holding.trim() || draft;
    // The sign-off is added here, word for word, not left to Claude.
    const text = body ? `${body}\n\n${signature}`.trim() : "";
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
        botId: bot?.id ?? null,
      })
      .where(eq(emailThreads.id, emailId));
    await deliver();
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
