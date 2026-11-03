"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { UserError } from "@/lib/errors";
import { adaptiveMessage, plainLine } from "@/lib/alerts/card";
import { checkMailbox } from "@/lib/channels/outlook";
import { postToTeams } from "@/lib/channels/teams";
import { botById } from "@/lib/bots/load";
import {
  botEmailSetup,
  removeMailbox,
  saveMailbox,
  setTeamsLink,
  teamsLinkOf,
} from "@/lib/emails/mailboxes";
import { normaliseMailbox, teamsLinkProblem } from "@/lib/emails/mailbox-rules";

/**
 * A bot's event mailbox and Teams channel. Admins only: a mailbox gives
 * Billie access to real email, and a Teams link posts into a channel.
 */
const bot = z.object({ botId: z.uuid() });

function refresh(id: string) {
  revalidatePath(`/bots/${id}`);
  revalidatePath("/settings");
}

export async function saveBotMailboxAction(input: unknown) {
  const schema = bot.extend({
    address: z
      .string()
      .trim()
      .max(254)
      .refine(
        (a) => normaliseMailbox(a) !== null,
        "Enter the mailbox's email address, like events@media-ten.com.",
      ),
    assignedUserId: z.uuid().nullable(),
    enabled: z.boolean(),
  });
  return runAction(
    "settings.manage",
    schema,
    input,
    async (actor, d) => {
      await saveMailbox(actor, d.botId, d);
      refresh(d.botId);
    },
    "Mailbox saved.",
  );
}

export async function removeBotMailboxAction(input: unknown) {
  return runAction(
    "settings.manage",
    bot,
    input,
    async (actor, d) => {
      await removeMailbox(actor, d.botId);
      refresh(d.botId);
    },
    "Billie no longer reads that mailbox.",
  );
}

export async function saveBotTeamsAction(input: unknown) {
  const schema = bot.extend({
    link: z
      .string()
      .trim()
      .min(1, "Paste the link from Teams.")
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
      await setTeamsLink(actor, d.botId, d.link);
      refresh(d.botId);
    },
    "Teams channel saved.",
  );
}

export async function removeBotTeamsAction(input: unknown) {
  return runAction(
    "settings.manage",
    bot,
    input,
    async (actor, d) => {
      await setTeamsLink(actor, d.botId, null);
      refresh(d.botId);
    },
    "Teams channel removed.",
  );
}

/** Can Billie open the mailbox? Read-only; nothing is changed. */
export async function checkBotMailboxAction(input: unknown) {
  return runAction(
    "settings.manage",
    bot,
    input,
    async (_actor, d) => {
      const { mailbox } = await botEmailSetup(d.botId);
      if (!mailbox) throw new UserError("Save the mailbox address first.");
      const problem = await checkMailbox(mailbox.address);
      if (problem) throw new UserError(problem);
    },
    "Billie can open the mailbox.",
  );
}

/** Posts a short test message in the bot's Teams channel. */
export async function testBotTeamsAction(input: unknown) {
  return runAction(
    "settings.manage",
    bot,
    input,
    async (_actor, d) => {
      const [row, link, setup] = await Promise.all([
        botById(d.botId),
        teamsLinkOf(d.botId),
        botEmailSetup(d.botId),
      ]);
      if (!row) throw new UserError("That bot no longer exists.");
      if (!link) throw new UserError("Save the Teams link first.");
      const where = setup.mailbox
        ? `an email arrives in ${setup.mailbox.address}`
        : "an email arrives";
      try {
        await postToTeams(
          link,
          adaptiveMessage({
            body: [
              plainLine(`${row.name}: test post from Billie`, {
                bold: true,
                size: "Medium",
                spacing: "None",
              }),
              plainLine(
                `This channel gets a post when ${where}, and when a chat with ${row.name} needs a person.`,
              ),
            ],
          }),
        );
      } catch {
        throw new UserError(
          "Teams didn't take the post. Check the link came from this channel's Workflows, and that the workflow is turned on.",
        );
      }
    },
    "Test post sent. Check the channel in Teams.",
  );
}
