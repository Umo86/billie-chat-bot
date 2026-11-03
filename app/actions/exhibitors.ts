"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { assertOnBot } from "@/lib/auth/bots";
import { UserError } from "@/lib/errors";
import { removeList, uploadList } from "@/lib/exhibitors/service";

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
