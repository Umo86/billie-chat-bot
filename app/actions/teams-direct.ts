"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { UserError } from "@/lib/errors";
import { adaptiveMessage, plainLine } from "@/lib/alerts/card";
import { cardOf, directLink, setDirectLink } from "@/lib/alerts/direct";
import { postToTeams } from "@/lib/channels/teams";
import { teamsLinkProblem } from "@/lib/emails/mailbox-rules";

/** Teams messages to people: the company's one workflow link. Admins only. */
function refresh() {
  revalidatePath("/settings");
  revalidatePath("/inbox");
}

export async function saveTeamsDirectAction(input: unknown) {
  const schema = z.object({
    link: z
      .string()
      .trim()
      .min(1, "Paste the link from the workflow.")
      .max(2000, "That link is too long to be from Teams.")
      .superRefine((link, ctx) => {
        const problem = teamsLinkProblem(link);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
  });
  return runAction(
    "settings.manage",
    schema,
    input,
    async (actor, d) => {
      await setDirectLink(actor, d.link);
      refresh();
    },
    "Saved. Send yourself a test message to check it.",
  );
}

export async function removeTeamsDirectAction(input: unknown) {
  return runAction(
    "settings.manage",
    z.object({}),
    input ?? {},
    async (actor) => {
      await setDirectLink(actor, null);
      refresh();
    },
    "Teams messages to people are off.",
  );
}

/** Sends the admin who clicks it a Teams message, through the workflow. */
export async function testTeamsDirectAction(input: unknown) {
  return runAction(
    "settings.manage",
    z.object({}),
    input ?? {},
    async (actor) => {
      const link = await directLink();
      if (!link) throw new UserError("Save the workflow link first.");
      const card = cardOf(
        adaptiveMessage({
          body: [
            plainLine("Billie: test message", { bold: true, size: "Medium", spacing: "None" }),
            plainLine(
              "This is how Billie tells you when a reply is waiting in Drafts, or someone on a show website wants a person.",
            ),
          ],
        }),
      );
      try {
        await postToTeams(link, { recipient: actor.email, card: JSON.stringify(card) });
      } catch {
        throw new UserError(
          "Teams didn't take the message. Check the link is from the workflow's trigger, and that the workflow is turned on.",
        );
      }
    },
    "Sent. It should arrive in Teams from Workflows within a minute.",
  );
}
