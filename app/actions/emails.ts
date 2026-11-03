"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, UserError } from "@/lib/actions/run";
import { assertOnBot, assertOnBotOf, mayOnBot } from "@/lib/auth/bots";
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
      // Only into a bot this person works on (an email with no bot is seen by admins only).
      if (d.botId) await assertOnBot(actor, "emails.handle", d.botId);
      else if (!(await mayOnBot(actor, "emails.handle", null)))
        throw new UserError("Choose which bot's knowledge to draft the reply from.");
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
      await assertOnBotOf(actor, "emails.handle", "email", d.id);
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
      await assertOnBotOf(actor, "emails.handle", "email", d.id);
      await finishEmail(actor, d.id, "sent", d.draft);
      refresh();
    },
    "Marked as sent.",
  );
}

export async function dismissEmailAction(input: unknown) {
  return runAction("emails.handle", id, input, async (actor, d) => {
    await assertOnBotOf(actor, "emails.handle", "email", d.id);
    await finishEmail(actor, d.id, "dismissed");
    refresh();
  });
}

export async function reopenEmailAction(input: unknown) {
  return runAction("emails.handle", id, input, async (actor, d) => {
    await assertOnBotOf(actor, "emails.handle", "email", d.id);
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
      await assertOnBotOf(actor, "emails.handle", "email", d.id);
      // Moving it to another bot: that one must be theirs too.
      if (d.botId !== undefined) await assertOnBot(actor, "emails.handle", d.botId);
      await redoDraft(actor, d.id, d.botId);
      refresh();
    },
    "Billie is writing the draft again.",
  );
}
