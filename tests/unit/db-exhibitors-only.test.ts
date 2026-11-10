import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, conversations, exhibitors } from "@/lib/db/schema";
import { uploadList } from "@/lib/exhibitors/service";
import { botById } from "@/lib/bots/load";
import { publicBot } from "@/lib/chat/public";
import { exhibitorsOnly, lockedLine } from "@/lib/chat/exhibitors-only";
import { startConversation, visitorMessage } from "@/lib/conversations/service";
import { updateBot } from "@/lib/bots/service";
import { POST as chatPost } from "@/app/api/public/chat/[slug]/[action]/route";
import { hasDb, makeBot, makeUser } from "../helpers/db";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.44" }),
}));
vi.mock("@/lib/jobs/kick", () => ({ kickJobs: async () => undefined }));

describe("the lines for anyone not signed in", () => {
  it("say how to sign in, by the ways this chat has", () => {
    expect(lockedLine({ code: true, manual: false }, "")).toBe(
      "This chat is for exhibitors. Sign in with Your stand, using the email you booked with, to ask a question.",
    );
    expect(lockedLine({ code: false, manual: true }, "")).toBe(
      "This chat is for exhibitors. Sign in to the exhibitor manual, then open the chat from there.",
    );
    expect(lockedLine({ code: true, manual: true }, "")).toMatch(/Your stand.*exhibitor manual/);
    expect(lockedLine({ code: false, manual: false }, "ops@ukcw.test")).toBe(
      "This chat is for exhibitors, and signing in isn't open yet. If you need something from us, please email the event team at ops@ukcw.test.",
    );
    expect(lockedLine({ code: true, manual: true }, "ops@ukcw.test", true)).toMatch(
      /^This chat is only for exhibitors signed in to the exhibitor manual.*ops@ukcw\.test\.$/,
    );
  });

  it("only count on an exhibitor bot with sign-in on", () => {
    const bot = { audience: "exhibitors" as const, personalAnswers: true, exhibitorsOnly: true };
    expect(exhibitorsOnly(bot)).toBe(true);
    expect(exhibitorsOnly({ ...bot, personalAnswers: false })).toBe(false);
    expect(exhibitorsOnly({ ...bot, audience: "visitors" })).toBe(false);
    expect(exhibitorsOnly({ ...bot, exhibitorsOnly: false })).toBe(false);
  });
});

const csv = (rows: string[][]) =>
  Buffer.from(rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n"));

async function lockedBot() {
  const admin = await makeUser("admin");
  const { bot: made } = await makeBot();
  const sam = `sam@acme-${randomUUID().slice(0, 8)}.test`;
  await uploadList(admin, made.id, {
    name: "exhibitors.csv",
    bytes: csv([
      ["Company", "Stand", "Contact", "Email"],
      ["Acme Ltd", "B12", "Sam Patel", sam],
    ]),
  });
  await db
    .update(bots)
    .set({ personalAnswers: true, contactEmail: "ops@ukcw.test" })
    .where(eq(bots.id, made.id));
  await updateBot(admin, made.id, { exhibitorsOnly: true });
  const [row] = await db
    .select()
    .from(exhibitors)
    .where(and(eq(exhibitors.botId, made.id), eq(exhibitors.stand, "B12")));
  return { admin, bot: (await botById(made.id))!, sam, row };
}

const call = (slug: string, action: string, body: unknown, token?: string) =>
  chatPost(
    new Request(`https://billie.test/api/public/chat/${slug}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug, action }) },
  );

describe.skipIf(!hasDb)("only signed-in exhibitors can chat (Postgres, stand-in Claude)", () => {
  it("tells the chat how to sign in", async () => {
    const { bot } = await lockedBot();
    expect(await publicBot(bot)).toMatchObject({
      exhibitorsOnly: true,
      // Email sending isn't set up in tests, and BluePrint isn't connected: nobody can sign in.
      signIn: false,
      manualSignIn: false,
      contactEmail: "ops@ukcw.test",
    });
  });

  it("refuses anyone not signed in, keeping nothing and asking Claude nothing", async () => {
    const { bot, row, sam } = await lockedBot();
    const res = await call(bot.slug, "messages", { text: "When does build-up start?" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      reason: "exhibitors_only",
      error: expect.stringMatching(/^This chat is for exhibitors, and signing in isn't open yet/),
    });
    expect(
      await db.select().from(conversations).where(eq(conversations.botId, bot.id)),
    ).toHaveLength(0);

    // A chat that isn't signed in can't ask, or pass itself to the team, either.
    const { conversation, token } = await startConversation({ bot, channel: "web" });
    for (const action of ["messages", "handover"])
      expect((await call(bot.slug, action, { text: "Hi" }, token!)).status).toBe(403);

    // Signed in: answered as usual.
    await db
      .update(conversations)
      .set({ exhibitorId: row.id, signedInEmail: sam, signedInAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    const ok = await call(bot.slug, "messages", { text: "Hello" }, token!);
    expect(ok.status).toBe(200);
    const turn = await ok.json();
    expect(turn.messages.at(-1)).toMatchObject({
      role: "bot",
      text: expect.stringMatching(/Hello/),
    });

    // Once the sign-in has run out: back to signing in.
    await db
      .update(conversations)
      .set({ signedInAt: new Date(Date.now() - 13 * 3_600_000) })
      .where(eq(conversations.id, conversation.id));
    expect((await call(bot.slug, "messages", { text: "And parking?" }, token!)).status).toBe(403);
  });

  it("answers WhatsApp with the way in, and lets the team try it", async () => {
    const { bot } = await lockedBot();
    const wa = await visitorMessage({
      bot,
      conversation: null,
      channel: "whatsapp",
      waId: `44${Date.now()}`.slice(0, 12),
      text: "When does build-up start?",
    });
    expect(wa.locked).toMatch(/only for exhibitors signed in to the exhibitor manual/);
    expect(wa.messages.at(-1)).toMatchObject({ role: "bot", text: wa.locked });

    const tried = await visitorMessage({
      bot,
      conversation: null,
      channel: "try",
      text: "Hello",
    });
    expect(tried.locked).toBeUndefined();
    expect(tried.messages.at(-1)!.text).toMatch(/Hello/);
  });

  it("is off again for a visitor bot", async () => {
    const { admin, bot } = await lockedBot();
    await db.delete(exhibitors).where(eq(exhibitors.botId, bot.id));
    // The kind can only change once the list has gone.
    await db.execute(sql`DELETE FROM exhibitor_lists WHERE bot_id = ${bot.id}`);
    await updateBot(admin, bot.id, { audience: "visitors" });
    expect((await botById(bot.id))!).toMatchObject({
      exhibitorsOnly: false,
      personalAnswers: false,
    });
  });
});
