"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { UserError } from "@/lib/errors";
import { updateSettings } from "@/lib/settings";
import { MODEL_IDS, modelName } from "@/lib/ai/pricing";
import { deletePerson, findPerson } from "@/lib/privacy/requests";
import { changeRole, createInvitation, revokeInvitation, setSuspended } from "@/lib/team/accounts";

const role = z.enum(["admin", "editor", "agent"]);

/** Settings → AI: the two ways Billie saves tokens, each on or off. */
export async function saveSavingsAction(input: unknown) {
  return runAction(
    "settings.manage",
    z.object({ tryFastFirst: z.boolean().optional(), reuseAnswers: z.boolean().optional() }),
    input,
    async (actor, d) => {
      const parts = [
        d.tryFastFirst === undefined
          ? null
          : `${d.tryFastFirst ? "on" : "off"}: Thorough bots try the Fast model first`,
        d.reuseAnswers === undefined
          ? null
          : `${d.reuseAnswers ? "on" : "off"}: the same answer again to the same first question`,
      ].filter(Boolean);
      await updateSettings(actor.id, d, `Switched ${parts.join("; ")}`);
      revalidatePath("/settings");
    },
    "Saved.",
  );
}

/** Settings → AI: the month's budget for Claude, and whether to stop at it. */
export async function saveBudgetAction(input: unknown) {
  return runAction(
    "settings.manage",
    z.object({
      dollars: z
        .number()
        .min(1, "Set at least $1, or leave it empty for no budget.")
        .max(100_000, "Keep it under $100,000.")
        .nullable(),
      hardStop: z.boolean(),
    }),
    input,
    async (actor, d) => {
      const cents = d.dollars === null ? null : Math.round(d.dollars * 100);
      await updateSettings(
        actor.id,
        { monthlyBudgetCents: cents, budgetHardStop: cents !== null && d.hardStop },
        cents === null
          ? "Removed the monthly Claude budget"
          : `Set the monthly Claude budget to $${(cents / 100).toFixed(2)}${d.hardStop ? ", stopping at it" : ""}`,
      );
      revalidatePath("/settings");
    },
    "Saved.",
  );
}

/** Settings → AI: which Claude model answers Fast and Thorough work. */
export async function saveModelsAction(input: unknown) {
  return runAction(
    "settings.manage",
    z.object({ fast: z.enum(MODEL_IDS), thorough: z.enum(MODEL_IDS) }),
    input,
    async (actor, d) => {
      await updateSettings(
        actor.id,
        { fastModel: d.fast, thoroughModel: d.thorough },
        `Chose the AI models: ${modelName(d.fast)} for fast work, ${modelName(d.thorough)} for thorough work`,
      );
      revalidatePath("/settings");
    },
    "Saved. New questions use these models now.",
  );
}

export async function saveSettingsAction(input: unknown) {
  const schema = z
    .object({
      companyName: z.string().trim().min(1).max(80),
      retentionMonths: z.number().int().min(1).max(84),
      dailyAnswerCap: z.number().int().min(10).max(1_000_000),
      consentText: z.string().trim().min(10, "Keep a short notice for people.").max(500),
      alertEmails: z
        .string()
        .max(1000)
        .refine(
          (s) =>
            s
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
              .every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)),
          "Use email addresses separated by commas.",
        ),
      weeklySummary: z.boolean(),
      nudgeAfterHours: z.number().int().min(0, "Use 0 to switch it off.").max(80),
      escalateAfterHours: z.number().int().min(0, "Use 0 to switch it off.").max(160),
      emailSignature: z.string().max(500),
      emailBotId: z.uuid().nullable(),
      whatsappVisitorBotId: z.uuid().nullable(),
      whatsappExhibitorBotId: z.uuid().nullable(),
    })
    .partial();
  return runAction(
    "settings.manage",
    schema,
    input,
    async (actor, d) => {
      await updateSettings(actor.id, d);
      revalidatePath("/settings");
    },
    "Saved.",
  );
}

export async function inviteAction(input: unknown) {
  const schema = z.object({
    email: z.email("That email doesn't look right."),
    name: z.string().trim().max(80).default(""),
    role,
    /** The bots they'll work on (editors and agents). */
    botIds: z.array(z.uuid()).max(200).default([]),
  });
  return runAction("team.manage", schema, input, async (actor, d) => {
    const result = await createInvitation(actor, d);
    revalidatePath("/settings");
    return result;
  });
}

export async function changeRoleAction(input: unknown) {
  return runAction(
    "team.manage",
    z.object({ userId: z.uuid(), role }),
    input,
    async (actor, d) => {
      await changeRole(actor, d.userId, d.role);
      revalidatePath("/settings");
    },
    "Role changed.",
  );
}

export async function suspendAction(input: unknown) {
  return runAction(
    "team.manage",
    z.object({ userId: z.uuid(), suspended: z.boolean() }),
    input,
    async (actor, d) => {
      await setSuspended(actor, d.userId, d.suspended);
      revalidatePath("/settings");
    },
  );
}

export async function revokeInviteAction(input: unknown) {
  return runAction("team.manage", z.object({ id: z.uuid() }), input, async (actor, d) => {
    await revokeInvitation(actor, d.id);
    revalidatePath("/settings");
  });
}

export async function findPersonAction(input: unknown) {
  return runAction(
    "data.export",
    z.object({ q: z.string().trim().min(3).max(200) }),
    input,
    async (_a, d) => findPerson(d.q),
  );
}

export async function deletePersonAction(input: unknown) {
  return runAction(
    "data.delete",
    z.object({ q: z.string().trim().min(3).max(200) }),
    input,
    async (actor, d) => {
      const done = await deletePerson(actor, d.q);
      revalidatePath("/inbox");
      revalidatePath("/emails");
      return done;
    },
  );
}

/** Checks Twenty's address and API key work (Settings → Connections). */
export async function checkTwentyAction() {
  return runAction(
    "settings.manage",
    z.object({}),
    {},
    async () => {
      const { checkTwenty, TwentyError } = await import("@/lib/crm/twenty");
      try {
        await checkTwenty();
      } catch (err) {
        if (err instanceof TwentyError) throw new UserError(err.message);
        throw err;
      }
    },
    "Twenty answered: Billie can send leads to it.",
  );
}
