"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { answerQuestion } from "@/lib/ai/answer";
import { answerBotFor, botById } from "@/lib/bots/load";
import {
  createBot,
  deleteBot,
  restoreBot,
  runTests,
  setKnowledge,
  setStatus,
  updateBot,
} from "@/lib/bots/service";
import { CONTACT_FIELDS } from "@/lib/bots/defaults";
import { validTime } from "@/lib/conversations/hours";
import { UserError } from "@/lib/errors";

const AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

const look = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the bot a name.")
    .max(60, "Keep the name under 60 characters."),
  audience: z.enum(["visitors", "exhibitors"]),
  showName: z.string().trim().max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour."),
  avatarUrl: z
    .string()
    .max(200_000, "That picture is too large.")
    .regex(AVATAR, "Use a PNG, JPEG or WebP picture.")
    .nullable(),
  welcome: z.string().trim().max(300),
  starters: z
    .array(z.string().trim().max(80))
    .max(3)
    .transform((a) => a.filter(Boolean)),
});

const rules = z.object({
  alwaysHuman: z.array(z.string().trim().min(1).max(60)).max(20),
  hours: z.object({
    days: z.array(z.number().int().min(0).max(6)).max(7),
    start: z.string().refine(validTime, "Use a time like 09:00."),
    end: z.string().refine(validTime, "Use a time like 17:30."),
  }),
  collect: z
    .array(z.enum(CONTACT_FIELDS as [string, ...string[]]))
    .transform((a) => a as typeof CONTACT_FIELDS),
  promise: z.string().trim().min(3).max(60),
});

const patch = z.object({
  id: z.uuid(),
  look: look.partial().optional(),
  tone: z.enum(["friendly", "formal", "brief"]).optional(),
  quality: z.enum(["fast", "thorough"]).optional(),
  rules: rules.optional(),
  domains: z.array(z.string().max(253)).max(30).optional(),
  tests: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        question: z.string().trim().min(1).max(300),
        mustMention: z.string().trim().max(120),
      }),
    )
    .max(50)
    .optional(),
});

function refresh(id?: string) {
  revalidatePath("/");
  if (id) revalidatePath(`/bots/${id}`);
}

export async function createBotAction(input: unknown) {
  return runAction("bots.edit", look, input, async (actor, data) => {
    const id = await createBot(actor, data);
    refresh();
    return { id };
  });
}

export async function updateBotAction(input: unknown) {
  return runAction(
    "bots.edit",
    patch,
    input,
    async (actor, data) => {
      await updateBot(actor, data.id, {
        ...(data.look ?? {}),
        ...(data.tone ? { tone: data.tone } : {}),
        ...(data.quality ? { quality: data.quality } : {}),
        ...(data.rules ? { rules: data.rules } : {}),
        ...(data.domains ? { domains: data.domains } : {}),
        ...(data.tests ? { tests: data.tests } : {}),
      });
      refresh(data.id);
    },
    "Saved.",
  );
}

export async function setBotKnowledgeAction(input: unknown) {
  return runAction(
    "bots.edit",
    z.object({ id: z.uuid(), kbIds: z.array(z.uuid()).max(20) }),
    input,
    async (actor, d) => {
      await setKnowledge(actor, d.id, d.kbIds);
      refresh(d.id);
    },
  );
}

export async function setBotStatusAction(input: unknown) {
  return runAction(
    "bots.publish",
    z.object({ id: z.uuid(), status: z.enum(["draft", "live"]) }),
    input,
    async (actor, d) => {
      await setStatus(actor, d.id, d.status);
      refresh(d.id);
    },
  );
}

export async function deleteBotAction(input: unknown) {
  return runAction("bots.delete", z.object({ id: z.uuid() }), input, async (actor, d) => {
    await deleteBot(actor, d.id);
    refresh();
  });
}

export async function restoreBotAction(input: unknown) {
  return runAction("bots.delete", z.object({ id: z.uuid() }), input, async (actor, d) => {
    await restoreBot(actor, d.id);
    refresh();
  });
}

export async function runTestsAction(input: unknown) {
  return runAction("bots.edit", z.object({ id: z.uuid() }), input, async (actor, d) => {
    const run = await runTests(actor, d.id);
    refresh(d.id);
    return run;
  });
}

/** The test console: answers like the live bot but saves nothing. */
export async function testAskAction(input: unknown) {
  const schema = z.object({
    id: z.uuid(),
    question: z.string().trim().min(1).max(2000),
    history: z
      .array(z.object({ role: z.enum(["visitor", "bot"]), text: z.string().max(4000) }))
      .max(20),
  });
  return runAction("bots.view", schema, input, async (_actor, d) => {
    const bot = await botById(d.id);
    if (!bot) throw new UserError("That bot no longer exists.");
    const a = await answerQuestion({
      bot: await answerBotFor(bot),
      history: d.history,
      question: d.question,
    });
    return {
      answer: a.answer,
      sources: a.sources.map((s) => ({ title: s.title, label: s.label })),
      handover: a.handover,
    };
  });
}
