"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { runAction } from "@/lib/actions/run";
import { assertOnBot } from "@/lib/auth/bots";
import { db } from "@/lib/db/client";
import { bots } from "@/lib/db/schema";
import { setSlackChannel, testSlackChannel } from "@/lib/alerts/slack-settings";

/** The Slack channel a bot posts to, or the company-wide one. Admins only. */
const channel = z.object({
  botId: z.uuid().nullable(),
  channelId: z
    .string()
    .trim()
    .max(30)
    .transform((v) => v || null),
});

export async function saveSlackChannelAction(input: unknown) {
  return runAction(
    "settings.manage",
    channel,
    input,
    async (actor, d) => {
      if (d.botId) await assertOnBot(actor, "settings.manage", d.botId);
      const name = await setSlackChannel(actor, d.botId, d.channelId);
      revalidatePath(d.botId ? `/bots/${d.botId}` : "/settings");
      return { name };
    },
    "Saved.",
  );
}

export async function testSlackChannelAction(input: unknown) {
  return runAction(
    "settings.manage",
    z.object({ botId: z.uuid().nullable() }),
    input,
    async (actor, d) => {
      let name: string | null = null;
      if (d.botId) {
        await assertOnBot(actor, "settings.manage", d.botId);
        const bot = await db.query.bots.findFirst({
          where: eq(bots.id, d.botId),
          columns: { name: true },
        });
        name = bot?.name ?? null;
      }
      await testSlackChannel(d.botId, name);
    },
    "Sent. Check the channel in Slack.",
  );
}
