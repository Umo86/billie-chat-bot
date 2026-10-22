"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { friendly, runAction } from "@/lib/actions/run";
import { fail, type ActionResult } from "@/lib/actions/result";
import { getActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { addSource, deleteSource, rereadSource, restoreSource } from "@/lib/knowledge/sources";
import {
  answerGap,
  createKnowledgeBase,
  dismissGap,
  renameKnowledgeBase,
  setKnowledgeBaseDeleted,
} from "@/lib/knowledge/bases";
import { passagesOf } from "@/lib/knowledge/queries";
import { fileKind, MAX_FILE_BYTES } from "@/lib/knowledge/extract";
import { putFile, storedBlobSize } from "@/lib/storage";
import { UserError } from "@/lib/errors";

const id = z.object({ id: z.uuid() });

function refresh() {
  revalidatePath("/knowledge");
  revalidatePath("/bots/[id]", "page");
  revalidatePath("/");
}

export async function createKbAction(input: unknown) {
  const schema = z.object({
    name: z.string().trim().min(1, "Give it a name.").max(80),
    description: z.string().max(200).default(""),
  });
  return runAction("knowledge.edit", schema, input, async (actor, d) => {
    const kbId = await createKnowledgeBase(actor, d.name, d.description);
    refresh();
    return { id: kbId };
  });
}

export async function renameKbAction(input: unknown) {
  const schema = z.object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(200).default(""),
  });
  return runAction(
    "knowledge.edit",
    schema,
    input,
    async (actor, d) => {
      await renameKnowledgeBase(actor, d.id, d.name, d.description);
      refresh();
    },
    "Saved.",
  );
}

export async function deleteKbAction(input: unknown) {
  return runAction("knowledge.edit", id, input, async (actor, d) => {
    await setKnowledgeBaseDeleted(actor, d.id, true);
    refresh();
  });
}

export async function restoreKbAction(input: unknown) {
  return runAction("knowledge.edit", id, input, async (actor, d) => {
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
      await addSource(actor, d.kbId, { kind: "web", url: d.url, refreshWeekly: d.refreshWeekly });
      refresh();
    },
    "Added. Billie is reading the page.",
  );
}

/** Small files straight through the action (under Vercel's 4.5 MB request limit). */
export async function uploadFileAction(form: FormData): Promise<ActionResult> {
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
    const fileKey = await putFile(
      file.name,
      Buffer.from(await file.arrayBuffer()),
      file.type || "application/octet-stream",
    );
    await addSource(actor, kbId, {
      kind: "file",
      name: file.name,
      fileKey,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    });
    refresh();
    return { ok: true };
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
    // Trust the store, not the browser: the file must really be there.
    const size = await storedBlobSize(d.pathname);
    if (size === null) throw new UserError(`${d.name} didn't finish uploading. Try again.`);
    await addSource(actor, d.kbId, {
      kind: "file",
      name: d.name,
      fileKey: `blob:${d.pathname}`,
      size,
      mimeType: d.type || "application/octet-stream",
    });
    refresh();
  });
}

export async function rereadAction(input: unknown) {
  return runAction(
    "knowledge.edit",
    id,
    input,
    async (actor, d) => {
      await rereadSource(actor, d.id);
      refresh();
    },
    "Billie is reading it again.",
  );
}

export async function deleteSourceAction(input: unknown) {
  return runAction("knowledge.edit", id, input, async (actor, d) => {
    await deleteSource(actor, d.id);
    refresh();
  });
}

export async function restoreSourceAction(input: unknown) {
  return runAction("knowledge.edit", id, input, async (actor, d) => {
    await restoreSource(actor, d.id);
    refresh();
  });
}

export async function passagesAction(input: unknown) {
  return runAction("knowledge.view", id, input, async (_actor, d) => passagesOf(d.id));
}

export async function answerGapAction(input: unknown) {
  const schema = z.object({
    gapId: z.uuid(),
    kbId: z.uuid(),
    answer: z.string().trim().min(2, "Write the answer.").max(4000),
  });
  return runAction(
    "knowledge.edit",
    schema,
    input,
    async (actor, d) => {
      await answerGap(actor, d.gapId, d.kbId, d.answer);
      refresh();
    },
    "Saved. Billie will use this answer from now on.",
  );
}

export async function dismissGapAction(input: unknown) {
  return runAction("knowledge.edit", z.object({ gapId: z.uuid() }), input, async (actor, d) => {
    await dismissGap(actor, d.gapId);
    refresh();
  });
}
