"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dismissUnhelpful, fixUnhelpful } from "@/lib/knowledge/unhelpful";
import { addWebsite, recrawlWebsite, removeWebsite, updateWebsite } from "@/lib/knowledge/websites";
import { leaveOutList, MAX_PAGES } from "@/lib/knowledge/sitemap";
import { dismissSuggestions, saveSuggestion, startHistory } from "@/lib/emails/history";
import { friendly, runAction } from "@/lib/actions/run";
import { fail, type ActionResult } from "@/lib/actions/result";
import { getActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { addSource, deleteSource, rereadSource, restoreSource } from "@/lib/knowledge/sources";
import {
  editSource,
  previewReplace,
  replaceInKnowledge,
  sourceForEdit,
} from "@/lib/knowledge/edit";
import { answerGap, dismissGap, setKnowledgeBaseDeleted } from "@/lib/knowledge/bases";
import { passagesOf, sourceStatuses } from "@/lib/knowledge/queries";
import { latestCheck, requestCheck } from "@/lib/knowledge/check";
import { fileKind, MAX_FILE_BYTES } from "@/lib/knowledge/files";
import { putFile, storedBlobSize } from "@/lib/storage";
import { UserError } from "@/lib/errors";
import { assertOnBot, assertOnBotOf } from "@/lib/auth/bots";
import { dismissLearning, saveLearning } from "@/lib/emails/learn";

const id = z.object({ id: z.uuid() });

function refresh() {
  revalidatePath("/knowledge");
  revalidatePath("/bots/[id]", "page");
  revalidatePath("/");
}

/** Only an old shared knowledge base no bot answers from (a bot's own goes with the bot). */
export async function deleteKbAction(input: unknown) {
  return runAction("knowledge.edit", id, input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "kb", d.id);
    await setKnowledgeBaseDeleted(actor, d.id, true);
    refresh();
  });
}

export async function restoreKbAction(input: unknown) {
  return runAction("knowledge.edit", id, input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "kb", d.id);
    await setKnowledgeBaseDeleted(actor, d.id, false);
    refresh();
  });
}

export async function addTextAction(input: unknown) {
  const schema = z.object({
    kbId: z.uuid(),
    title: z.string().trim().max(200),
    body: z.string().trim().min(1, "Paste some text first.").max(2_000_000),
  });
  return runAction(
    "knowledge.edit",
    schema,
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "kb", d.kbId);
      await addSource(actor, d.kbId, { kind: "text", title: d.title, body: d.body });
      refresh();
    },
    "Added. Billie is reading it.",
  );
}

export async function addQaAction(input: unknown) {
  const schema = z.object({
    kbId: z.uuid(),
    question: z.string().trim().min(3, "Write the question.").max(300),
    answer: z.string().trim().min(2, "Write the answer.").max(4000),
  });
  return runAction(
    "knowledge.edit",
    schema,
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "kb", d.kbId);
      await addSource(actor, d.kbId, { kind: "qa", question: d.question, answer: d.answer });
      refresh();
    },
    "Answer saved.",
  );
}

export async function addWebAction(input: unknown) {
  const schema = z.object({
    kbId: z.uuid(),
    url: z.string().trim().min(4, "Paste the page's address.").max(2000),
    refreshWeekly: z.boolean().default(true),
  });
  return runAction(
    "knowledge.edit",
    schema,
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "kb", d.kbId);
      await addSource(actor, d.kbId, { kind: "web", url: d.url, refreshWeekly: d.refreshWeekly });
      refresh();
    },
    "Added. Billie is reading the page.",
  );
}

const website = {
  leaveOut: z.string().max(3000).default(""),
  maxPages: z
    .number()
    .int()
    .min(1, "Read at least 1 page.")
    .max(MAX_PAGES, `At most ${MAX_PAGES} pages.`),
};

/** A whole website: its pages from the sitemap (or the home page's links), read weekly. */
export async function addWebsiteAction(input: unknown) {
  return runAction(
    "knowledge.edit",
    z.object({
      kbId: z.uuid(),
      url: z.string().trim().min(4, "Paste the website's address.").max(2000),
      ...website,
    }),
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "kb", d.kbId);
      await addWebsite(actor, d.kbId, {
        url: d.url,
        leaveOut: leaveOutList(d.leaveOut),
        maxPages: d.maxPages,
      });
      refresh();
    },
    "Added. Billie is finding the website's pages.",
  );
}

export async function updateWebsiteAction(input: unknown) {
  return runAction(
    "knowledge.edit",
    z.object({ id: z.uuid(), ...website }),
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "website", d.id);
      await updateWebsite(actor, d.id, {
        leaveOut: leaveOutList(d.leaveOut),
        maxPages: d.maxPages,
      });
      refresh();
    },
    "Saved. Billie is looking at the website again.",
  );
}

export async function recrawlWebsiteAction(input: unknown) {
  return runAction(
    "knowledge.edit",
    z.object({ id: z.uuid() }),
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "website", d.id);
      await recrawlWebsite(actor, d.id);
      refresh();
    },
    "Billie is reading the website again.",
  );
}

export async function removeWebsiteAction(input: unknown) {
  return runAction(
    "knowledge.edit",
    z.object({ id: z.uuid() }),
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "website", d.id);
      await removeWebsite(actor, d.id);
      refresh();
    },
    "Removed. Its pages are in the bin for 30 days.",
  );
}

/** Small files straight through the action (under Vercel's 4.5 MB request limit). */
export async function uploadFileAction(form: FormData): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  if (!actor) return fail("Your session has ended. Sign in again.");
  if (!can(actor, "knowledge.edit")) return fail("You don't have access to do that.");
  const kbId = String(form.get("kbId") ?? "");
  const file = form.get("file");
  if (!z.uuid().safeParse(kbId).success || !(file instanceof File)) return fail("Choose a file.");
  if (!fileKind(file.name, file.type))
    return fail(`${file.name}: Billie reads PDF, Word (.docx), Excel (.xlsx), CSV and text files.`);
  if (file.size > Math.min(MAX_FILE_BYTES, 4 * 1024 * 1024))
    return fail(`${file.name} is too large to upload this way.`);
  try {
    await assertOnBotOf(actor, "knowledge.edit", "kb", kbId);
    const fileKey = await putFile(
      file.name,
      Buffer.from(await file.arrayBuffer()),
      file.type || "application/octet-stream",
    );
    const id = await addSource(actor, kbId, {
      kind: "file",
      name: file.name,
      fileKey,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    });
    refresh();
    return { ok: true, data: { id } };
  } catch (err) {
    const text = friendly(err);
    if (text) return fail(text);
    if (err instanceof Error && /storage isn't set up/.test(err.message)) return fail(err.message);
    console.error("upload failed", err);
    return fail(`${file.name} couldn't be uploaded. Try again.`);
  }
}

/** Big files went straight from the browser to Vercel Blob; this records them. */
export async function registerUploadAction(input: unknown) {
  const schema = z.object({
    kbId: z.uuid(),
    pathname: z
      .string()
      .regex(/^sources\/[\w./-]+$/)
      .refine((p) => !p.includes(".."))
      .max(400),
    name: z.string().min(1).max(255),
    size: z.number().int().positive().max(MAX_FILE_BYTES),
    type: z.string().max(200),
  });
  return runAction("knowledge.edit", schema, input, async (actor, d) => {
    if (!fileKind(d.name, d.type))
      throw new UserError("Billie reads PDF, Word (.docx), Excel (.xlsx), CSV and text files.");
    await assertOnBotOf(actor, "knowledge.edit", "kb", d.kbId);
    // Trust the store, not the browser: the file must really be there.
    const size = await storedBlobSize(d.pathname);
    if (size === null) throw new UserError(`${d.name} didn't finish uploading. Try again.`);
    const id = await addSource(actor, d.kbId, {
      kind: "file",
      name: d.name,
      fileKey: `blob:${d.pathname}`,
      size,
      mimeType: d.type || "application/octet-stream",
    });
    refresh();
    return { id };
  });
}

/** How the reading of new files is going, for the "Billie is learning" panel. */
export async function sourceStatusAction(input: unknown) {
  const schema = z.object({ ids: z.array(z.uuid()).min(1).max(20) });
  return runAction("knowledge.view", schema, input, async (actor, d) => {
    for (const s of d.ids) await assertOnBotOf(actor, "knowledge.view", "source", s);
    return sourceStatuses(d.ids);
  });
}

export async function rereadAction(input: unknown) {
  return runAction(
    "knowledge.edit",
    id,
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "source", d.id);
      await rereadSource(actor, d.id);
      refresh();
    },
    "Billie is reading it again.",
  );
}

export async function deleteSourceAction(input: unknown) {
  return runAction("knowledge.edit", id, input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "source", d.id);
    await deleteSource(actor, d.id);
    refresh();
  });
}

export async function restoreSourceAction(input: unknown) {
  return runAction("knowledge.edit", id, input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "source", d.id);
    await restoreSource(actor, d.id);
    refresh();
  });
}

export async function passagesAction(input: unknown) {
  return runAction("knowledge.view", id, input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.view", "source", d.id);
    return passagesOf(d.id);
  });
}

/** The text of a pasted text or typed answer, for the Edit dialog. */
export async function sourceTextAction(input: unknown) {
  return runAction("knowledge.edit", id, input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "source", d.id);
    return sourceForEdit(d.id);
  });
}

export async function editSourceAction(input: unknown) {
  const schema = z.discriminatedUnion("kind", [
    z.object({
      id: z.uuid(),
      kind: z.literal("text"),
      title: z.string().trim().max(200),
      body: z.string().trim().min(1, "Write some text.").max(2_000_000),
      version: z.string().max(40).optional(),
    }),
    z.object({
      id: z.uuid(),
      kind: z.literal("qa"),
      question: z.string().trim().min(3, "Write the question.").max(300),
      answer: z.string().trim().min(2, "Write the answer.").max(4000),
      version: z.string().max(40).optional(),
    }),
  ]);
  return runAction("knowledge.edit", schema, input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "source", d.id);
    const changed = await editSource(
      actor,
      d.id,
      d.kind === "text"
        ? { kind: "text", title: d.title, body: d.body }
        : { kind: "qa", question: d.question, answer: d.answer },
      d.version,
    );
    if (changed) refresh();
    return { changed };
  });
}

const replaceSchema = z.object({
  kbId: z.uuid(),
  find: z.string().trim().min(2, "Type at least 2 characters to find.").max(200),
  replace: z.string().trim().max(500),
});

export async function previewReplaceAction(input: unknown) {
  return runAction("knowledge.edit", replaceSchema, input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "kb", d.kbId);
    return previewReplace(d.kbId, d.find, d.replace);
  });
}

export async function replaceAction(input: unknown) {
  return runAction("knowledge.edit", replaceSchema, input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "kb", d.kbId);
    const done = await replaceInKnowledge(actor, d.kbId, d.find, d.replace);
    if (done.sources) refresh();
    return done;
  });
}

/** The answer goes into the knowledge of the bot that was asked. */
export async function answerGapAction(input: unknown) {
  const schema = z.object({
    gapId: z.uuid(),
    answer: z.string().trim().min(2, "Write the answer.").max(4000),
  });
  return runAction(
    "knowledge.edit",
    schema,
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "gap", d.gapId);
      await answerGap(actor, d.gapId, d.answer);
      refresh();
    },
    "Saved. Billie will use this answer from now on.",
  );
}

export async function dismissGapAction(input: unknown) {
  return runAction("knowledge.edit", z.object({ gapId: z.uuid() }), input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "gap", d.gapId);
    await dismissGap(actor, d.gapId);
    refresh();
  });
}

/** A better answer to one people marked unhelpful: saved as a typed answer. */
export async function fixUnhelpfulAction(input: unknown) {
  return runAction(
    "knowledge.edit",
    z.object({
      id: z.uuid(),
      answer: z.string().trim().min(2, "Write the answer.").max(4000),
    }),
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "unhelpful", d.id);
      await fixUnhelpful(actor, d.id, d.answer);
      refresh();
    },
    "Saved. Billie will use this answer from now on.",
  );
}

export async function dismissUnhelpfulAction(input: unknown) {
  return runAction("knowledge.edit", z.object({ id: z.uuid() }), input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "unhelpful", d.id);
    await dismissUnhelpful(actor, d.id);
    refresh();
  });
}

/** Asks Billie to check a knowledge base for contradictions, passed dates and contacts. */
export async function checkKnowledgeAction(input: unknown) {
  return runAction("knowledge.edit", z.object({ kbId: z.uuid() }), input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "kb", d.kbId);
    await requestCheck(actor, d.kbId);
    refresh();
    return latestCheck(d.kbId);
  });
}

/** The latest check, while the screen waits for it to finish. */
export async function checkStatusAction(input: unknown) {
  return runAction("knowledge.view", z.object({ kbId: z.uuid() }), input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.view", "kb", d.kbId);
    return latestCheck(d.kbId);
  });
}

/** A correction from a sent email, saved (as the person edited it) as a typed answer. */
export async function saveLearningAction(input: unknown) {
  const schema = z.object({
    emailId: z.uuid(),
    question: z.string().trim().min(3, "Write the question.").max(300),
    answer: z.string().trim().min(2, "Write the answer.").max(4000),
  });
  return runAction(
    "knowledge.edit",
    schema,
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "email", d.emailId);
      await saveLearning(actor, d.emailId, { question: d.question, answer: d.answer });
      refresh();
    },
    "Saved. Billie will use this answer from now on.",
  );
}

/** Reads the mailbox's past emails for the questions people often ask (on the queue). */
export async function startHistoryAction(input: unknown) {
  return runAction(
    "knowledge.edit",
    z.object({ botId: z.uuid(), months: z.union([z.literal(3), z.literal(6), z.literal(12)]) }),
    input,
    async (actor, d) => {
      await assertOnBot(actor, "knowledge.edit", d.botId);
      await startHistory(actor, d.botId, d.months);
      refresh();
      revalidatePath(`/bots/${d.botId}`);
    },
    "Billie is reading the past emails. The questions it finds appear on the Knowledge page.",
  );
}

export async function saveSuggestionAction(input: unknown) {
  const schema = z.object({
    id: z.uuid(),
    question: z.string().trim().min(3, "Write the question.").max(300),
    answer: z.string().trim().min(2, "Write the answer.").max(4000),
  });
  return runAction(
    "knowledge.edit",
    schema,
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "knowledge.edit", "suggestion", d.id);
      await saveSuggestion(actor, d.id, { question: d.question, answer: d.answer });
      refresh();
    },
    "Saved. Billie will use this answer from now on.",
  );
}

export async function dismissSuggestionsAction(input: unknown) {
  return runAction(
    "knowledge.edit",
    z.object({ ids: z.array(z.uuid()).min(1).max(200) }),
    input,
    async (actor, d) => {
      for (const id of d.ids) await assertOnBotOf(actor, "knowledge.edit", "suggestion", id);
      await dismissSuggestions(actor, d.ids);
      refresh();
    },
  );
}

export async function dismissLearningAction(input: unknown) {
  return runAction("knowledge.edit", z.object({ emailId: z.uuid() }), input, async (actor, d) => {
    await assertOnBotOf(actor, "knowledge.edit", "email", d.emailId);
    await dismissLearning(actor, d.emailId);
    refresh();
  });
}
