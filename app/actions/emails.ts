"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import {
  addPastedEmail,
  finishEmail,
  redoDraft,
  reopenEmail,
  saveDraft,
} from "@/lib/emails/service";

const id = z.object({ id: z.uuid() });

function refresh() {
  revalidatePath("/emails");
  revalidatePath("/", "layout");
}

export async function pasteEmailAction(input: unknown) {
  const schema = z.object({
    fromName: z.string().max(120).default(""),
    fromEmail: z
      .union([z.literal(""), z.email("That email address doesn't look right.")])
      .default(""),
    subject: z.string().max(300).default(""),
    body: z.string().trim().min(5, "Paste the email's text.").max(50_000),
    botId: z.uuid().nullable().default(null),
  });
  return runAction(
    "emails.handle",
    schema,
    input,
    async (actor, d) => {
      const emailId = await addPastedEmail(actor, d);
      refresh();
      return { id: emailId };
    },
    "Added. Billie is writing a draft reply.",
  );
}

export async function saveDraftAction(input: unknown) {
  return runAction(
    "emails.handle",
    id.extend({ draft: z.string().max(20_000) }),
    input,
    async (actor, d) => {
      await saveDraft(actor, d.id, d.draft);
      refresh();
    },
    "Draft saved.",
  );
}

export async function markSentAction(input: unknown) {
  return runAction(
    "emails.handle",
    id.extend({ draft: z.string().max(20_000).optional() }),
    input,
    async (actor, d) => {
      await finishEmail(actor, d.id, "sent", d.draft);
      refresh();
    },
    "Marked as sent.",
  );
}

export async function dismissEmailAction(input: unknown) {
  return runAction("emails.handle", id, input, async (actor, d) => {
    await finishEmail(actor, d.id, "dismissed");
    refresh();
  });
}

export async function reopenEmailAction(input: unknown) {
  return runAction("emails.handle", id, input, async (actor, d) => {
    await reopenEmail(actor, d.id);
    refresh();
  });
}

export async function redoDraftAction(input: unknown) {
  return runAction(
    "emails.handle",
    id.extend({ botId: z.uuid().nullable().optional() }),
    input,
    async (actor, d) => {
      await redoDraft(actor, d.id, d.botId);
      refresh();
    },
    "Billie is writing the draft again.",
  );
}
