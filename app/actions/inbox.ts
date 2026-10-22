"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { setAvailable } from "@/lib/conversations/presence";
import { closeConversation, handBack, staffReply } from "@/lib/conversations/service";
import { addSource } from "@/lib/knowledge/sources";
import { UserError } from "@/lib/errors";

const conv = z.object({ conversationId: z.uuid() });

function refresh() {
  revalidatePath("/inbox");
  revalidatePath("/", "layout");
}

export async function setAvailabilityAction(input: unknown) {
  return runAction("inbox.view", z.object({ available: z.boolean() }), input, async (actor, d) => {
    await setAvailable(actor.id, d.available);
    refresh();
  });
}

export async function replyAction(input: unknown) {
  const schema = conv.extend({ text: z.string().trim().min(1, "Write a reply first.").max(4000) });
  return runAction("inbox.reply", schema, input, async (actor, d) => {
    await staffReply(actor, d.conversationId, d.text);
    refresh();
  });
}

export async function handBackAction(input: unknown) {
  return runAction(
    "inbox.reply",
    conv,
    input,
    async (actor, d) => {
      await handBack(actor, d.conversationId);
      refresh();
    },
    "Back with Billie.",
  );
}

export async function closeChatAction(input: unknown) {
  return runAction(
    "inbox.reply",
    conv,
    input,
    async (actor, d) => {
      await closeConversation(actor, d.conversationId);
      refresh();
    },
    "Chat closed.",
  );
}

/** Teach the bot: a question from a chat and the right answer become a typed answer. */
export async function saveAsAnswerAction(input: unknown) {
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
      if (!d.kbId) throw new UserError("Choose a knowledge base.");
      await addSource(actor, d.kbId, { kind: "qa", question: d.question, answer: d.answer });
      revalidatePath("/knowledge");
    },
    "Saved. The bot will use this answer from now on.",
  );
}
