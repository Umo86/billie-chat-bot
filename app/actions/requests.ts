"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { updateRequest } from "@/lib/requests/service";

/** Status, owner and the message to the person on a request from chat. */
export async function updateRequestAction(input: unknown) {
  const schema = z.object({
    id: z.uuid(),
    status: z.enum(["new", "in_progress", "done", "declined"]).optional(),
    note: z.string().max(2000, "Keep the message under 2,000 characters.").optional(),
    assignedTo: z.uuid().nullable().optional(),
  });
  return runAction(
    "inbox.reply",
    schema,
    input,
    async (actor, d) => {
      await updateRequest(actor, d.id, {
        status: d.status,
        note: d.note,
        assignedTo: d.assignedTo,
      });
      revalidatePath("/requests");
    },
    "Saved.",
  );
}
