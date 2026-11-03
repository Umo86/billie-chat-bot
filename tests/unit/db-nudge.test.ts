import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botMailboxes, conversations, emailThreads, jobs, settings } from "@/lib/db/schema";
import { setDirectLink } from "@/lib/alerts/direct";
import { runNudges } from "@/lib/alerts/nudge";
import { hasDb, makeBot, makeUser, putOnBot } from "../helpers/db";
import { DIRECT } from "../helpers/microsoft";

// Wednesday 4 November 2026, 15:00 UK time; team hours are Mon–Fri 09:00–17:30.
const NOW = new Date("2026-11-04T15:00:00Z");

async function sentTo(key: string) {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "teams_direct"), like(jobs.dedupeKey, `dm:${key}%`)));
  return rows.map((r) => (r.payload as { to: string }).to).sort();
}

describe.skipIf(!hasDb)("nudges when nobody has replied (Postgres)", () => {
  afterAll(async () => {
    await db
      .update(settings)
      .set({ teamsDmWebhookUrl: null, nudgeAfterHours: 4, escalateAfterHours: 8 });
  });

  it("reminds whoever handles a chat after 4 working hours, and admins after 8, once each", async () => {
    const admin = await makeUser("admin");
    const manager = await makeUser("agent");
    await setDirectLink(admin, DIRECT);
    await db.update(settings).set({ nudgeAfterHours: 4, escalateAfterHours: 8 });
    const { bot } = await makeBot();
    await putOnBot(bot.id, manager.id);
    await db.insert(botMailboxes).values({
      botId: bot.id,
      address: `nudge-${randomUUID().slice(0, 8)}@media-ten.test`,
      assignedUserId: manager.id,
    });
    const chat = async (handoverAt: string, status: "waiting" | "ticket" = "ticket") =>
      (
        await db
          .insert(conversations)
          .values({
            botId: bot.id,
            channel: "web",
            status,
            handoverAt: new Date(handoverAt),
            firstQuestion: "Can we build until 22:00?",
            contact: { name: "Sam Lee", company: "Northern Stands" },
          })
          .returning()
      )[0];
    const old = await chat("2026-11-02T10:00:00Z"); // two working days ago
    const morning = await chat("2026-11-04T10:00:00Z", "waiting"); // 5 working hours
    const recent = await chat("2026-11-04T13:30:00Z"); // 1.5 hours

    await runNudges(NOW);
    const at = (c: typeof old) => `nudge:chat:${c.id}:${c.handoverAt!.getTime()}`;
    expect(await sentTo(`${at(old)}:1`)).toEqual([manager.email]);
    expect(await sentTo(`${at(old)}:2`)).toContain(admin.email);
    expect(await sentTo(`${at(morning)}:1`)).toEqual([manager.email]);
    expect(await sentTo(`${at(morning)}:2`)).toEqual([]);
    expect(await sentTo(at(recent))).toEqual([]);

    // Running again sends nothing new.
    const before = (await sentTo("nudge:chat:")).length;
    await runNudges(NOW);
    expect((await sentTo("nudge:chat:")).length).toBe(before);

    // Once someone replies, the chat isn't waiting any more.
    await db
      .update(conversations)
      .set({ status: "replied" })
      .where(eq(conversations.id, recent.id));
    await runNudges(new Date("2026-11-05T15:00:00Z"));
    expect(await sentTo(at(recent))).toEqual([]);
  });

  it("does the same for an email that needs a person, and does nothing when switched off", async () => {
    const admin = await makeUser("admin");
    const manager = await makeUser("agent");
    await setDirectLink(admin, DIRECT);
    const { bot } = await makeBot();
    await putOnBot(bot.id, manager.id);
    await db.insert(botMailboxes).values({
      botId: bot.id,
      address: `nudge-${randomUUID().slice(0, 8)}@media-ten.test`,
      assignedUserId: manager.id,
    });
    const [email] = await db
      .insert(emailThreads)
      .values({
        source: "manual",
        botId: bot.id,
        fromName: "Jo Patel",
        fromEmail: "jo@stands.test",
        subject: "Refund for our stand",
        body: "Please refund us.",
        status: "needs_you",
        receivedAt: new Date("2026-11-03T09:00:00Z"),
      })
      .returning();
    const key = `nudge:email:${email.id}:${email.receivedAt.getTime()}`;

    await db.update(settings).set({ nudgeAfterHours: 0, escalateAfterHours: 0 });
    await runNudges(NOW);
    expect(await sentTo(key)).toEqual([]);

    await db.update(settings).set({ nudgeAfterHours: 4, escalateAfterHours: 8 });
    await runNudges(NOW);
    expect(await sentTo(`${key}:1`)).toEqual([manager.email]);
    expect(await sentTo(`${key}:2`)).toContain(admin.email);
  });
});
