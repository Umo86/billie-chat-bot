"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { updateSettings } from "@/lib/settings";
import { deletePerson, findPerson } from "@/lib/privacy/requests";
import { changeRole, createInvitation, revokeInvitation, setSuspended } from "@/lib/team/accounts";

const role = z.enum(["admin", "editor", "agent"]);

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
