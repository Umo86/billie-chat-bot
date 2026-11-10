"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { assertOnBot, assertOnBotOf } from "@/lib/auth/bots";
import { UserError } from "@/lib/errors";
import { removeList, setHiddenColumns, uploadList } from "@/lib/exhibitors/service";
import { makeBlueprintKey, removeBlueprintKey } from "@/lib/exhibitors/blueprint";
import {
  deleteDeadline,
  saveDeadline,
  saveReminderPlan,
  startReminders,
} from "@/lib/exhibitors/deadlines";
import {
  discardReminders,
  retryFailedReminders,
  saveReminderText,
  sendReminders,
} from "@/lib/exhibitors/reminders";

/** Under the server action limit (next.config.ts), and far more than 5,000 rows need. */
const MAX_LIST_BYTES = 4 * 1024 * 1024;

const upload = z.object({
  botId: z.uuid(),
  file: z.instanceof(File, { message: "Choose a file." }),
});

/**
 * A bot's exhibitor list. It's read straight away, not on the job queue: it's
 * small, and whoever uploads it needs to see at once which columns Billie found.
 */
export async function uploadExhibitorListAction(form: FormData) {
  return runAction(
    "bots.edit",
    upload,
    { botId: form.get("botId"), file: form.get("file") },
    async (actor, d) => {
      await assertOnBot(actor, "bots.edit", d.botId);
      if (!d.file.size) throw new UserError("That file is empty. Choose the exhibitor list.");
      if (d.file.size > MAX_LIST_BYTES)
        throw new UserError(
          "That file is over 4 MB. Save it as CSV, or take out columns Billie doesn't need.",
        );
      const summary = await uploadList(actor, d.botId, {
        name: d.file.name,
        bytes: Buffer.from(await d.file.arrayBuffer()),
      });
      revalidatePath(`/bots/${d.botId}`);
      return { rows: summary.rows, skipped: summary.skipped };
    },
  );
}

/** The columns Billie may use when a signed-in exhibitor asks about their stand. */
export async function saveHiddenColumnsAction(input: unknown) {
  return runAction(
    "bots.edit",
    z.object({ botId: z.uuid(), hidden: z.array(z.string().max(300)).max(100) }),
    input,
    async (actor, d) => {
      await assertOnBot(actor, "bots.edit", d.botId);
      await setHiddenColumns(actor, d.botId, d.hidden);
      revalidatePath(`/bots/${d.botId}`);
    },
    "Saved.",
  );
}

export async function removeExhibitorListAction(input: unknown) {
  return runAction(
    "bots.edit",
    z.object({ botId: z.uuid() }),
    input,
    async (actor, d) => {
      await assertOnBot(actor, "bots.edit", d.botId);
      await removeList(actor, d.botId);
      revalidatePath(`/bots/${d.botId}`);
    },
    "List removed.",
  );
}

/**
 * BluePrint, the exhibitor manual: a key to put in the show's settings there.
 * Admins only, like the bot's other connections. It's returned once, to show.
 */
export async function makeBlueprintKeyAction(input: unknown) {
  return runAction("settings.manage", z.object({ botId: z.uuid() }), input, async (actor, d) => {
    await assertOnBot(actor, "settings.manage", d.botId);
    const key = await makeBlueprintKey(actor, d.botId);
    revalidatePath(`/bots/${d.botId}`);
    return { key };
  });
}

export async function removeBlueprintKeyAction(input: unknown) {
  return runAction(
    "settings.manage",
    z.object({ botId: z.uuid() }),
    input,
    async (actor, d) => {
      await assertOnBot(actor, "settings.manage", d.botId);
      await removeBlueprintKey(actor, d.botId);
      revalidatePath(`/bots/${d.botId}`);
    },
    "BluePrint disconnected.",
  );
}

const deadlineBody = z.object({
  botId: z.uuid(),
  id: z.uuid().optional(),
  name: z.string().max(200),
  dueOn: z.string().max(10),
  column: z.string().max(300),
  doneValues: z.array(z.string().max(500)).max(100),
  remindDaysBefore: z.number().int(),
  linkId: z.string().max(40).nullable().optional(),
});

export async function saveDeadlineAction(input: unknown) {
  return runAction(
    "bots.edit",
    deadlineBody,
    input,
    async (actor, d) => {
      await assertOnBot(actor, "bots.edit", d.botId);
      const id = await saveDeadline(actor, d.botId, d, d.id);
      revalidatePath(`/bots/${d.botId}`);
      return { id };
    },
    "Deadline saved.",
  );
}

export async function deleteDeadlineAction(input: unknown) {
  return runAction(
    "bots.edit",
    z.object({ id: z.uuid() }),
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "bots.edit", "deadline", d.id);
      await deleteDeadline(actor, d.id);
      revalidatePath("/bots/[id]", "page");
    },
    "Deadline deleted.",
  );
}

/**
 * How often a bot's reminders go (Exhibitors step). Repeats can be sent without
 * a check, so it's for whoever may send reminders.
 */
export async function saveReminderPlanAction(input: unknown) {
  return runAction(
    "reminders.send",
    z.object({
      botId: z.uuid(),
      repeatDays: z.union([z.literal(0), z.literal(3), z.literal(7)]),
      autoSend: z.boolean(),
      gapDays: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(7)]),
      weekdaysOnly: z.boolean(),
    }),
    input,
    async (actor, d) => {
      await assertOnBot(actor, "reminders.send", d.botId);
      await saveReminderPlan(actor, d.botId, d);
      revalidatePath(`/bots/${d.botId}`);
    },
    "Saved.",
  );
}

/** Billie drafts reminders now, for everyone who hasn't done it. */
export async function startRemindersAction(input: unknown) {
  return runAction("bots.edit", z.object({ deadlineId: z.uuid() }), input, async (actor, d) => {
    await assertOnBotOf(actor, "bots.edit", "deadline", d.deadlineId);
    const started = await startReminders(actor, d.deadlineId);
    revalidatePath("/bots/[id]", "page");
    return started;
  });
}

const reminderText = z.object({
  batchId: z.uuid(),
  subject: z.string().max(1000),
  body: z.string().max(20_000),
});

export async function saveReminderTextAction(input: unknown) {
  return runAction(
    "reminders.send",
    reminderText,
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "reminders.send", "reminders", d.batchId);
      await saveReminderText(actor, d.batchId, d);
      revalidatePath("/bots/[id]/reminders/[batchId]", "page");
    },
    "Saved.",
  );
}

export async function sendRemindersAction(input: unknown) {
  return runAction(
    "reminders.send",
    reminderText.extend({ leaveOut: z.array(z.uuid()).max(10_000) }),
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "reminders.send", "reminders", d.batchId);
      const sent = await sendReminders(actor, d.batchId, d);
      revalidatePath("/bots/[id]/reminders/[batchId]", "page");
      revalidatePath("/bots/[id]", "page");
      return sent;
    },
  );
}

export async function discardRemindersAction(input: unknown) {
  return runAction(
    "reminders.send",
    z.object({ batchId: z.uuid() }),
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "reminders.send", "reminders", d.batchId);
      await discardReminders(actor, d.batchId);
      revalidatePath("/bots/[id]/reminders/[batchId]", "page");
      revalidatePath("/bots/[id]", "page");
    },
    "Discarded.",
  );
}

export async function retryFailedRemindersAction(input: unknown) {
  return runAction(
    "reminders.send",
    z.object({ batchId: z.uuid() }),
    input,
    async (actor, d) => {
      await assertOnBotOf(actor, "reminders.send", "reminders", d.batchId);
      await retryFailedReminders(actor, d.batchId);
      revalidatePath("/bots/[id]/reminders/[batchId]", "page");
    },
    "Trying them again.",
  );
}
