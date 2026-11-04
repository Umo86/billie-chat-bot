import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  auditLog,
  blueprintLinks,
  bots,
  conversations,
  exhibitors,
  messages,
} from "@/lib/db/schema";
import {
  botForKey,
  blueprintStatus,
  makeBlueprintKey,
  manualSignInOpen,
  readManualSignIn,
  removeBlueprintKey,
  signInFromManual,
  syncFromBlueprint,
} from "@/lib/exhibitors/blueprint";
import { readSync, signToken } from "@/lib/exhibitors/blueprint-rules";
import { listSummary, setHiddenColumns, signInOpen, uploadList } from "@/lib/exhibitors/service";
import { startConversation, visitorMessage, visitorUpdates } from "@/lib/conversations/service";
import { botById } from "@/lib/bots/load";
import { hasDb, makeBot, makeUser } from "../helpers/db";

/** Email sending isn't set up: signing in from the manual needs no codes. */
beforeAll(() => {
  vi.stubEnv("RESEND_API_KEY", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

/** Each bot's key, as BluePrint holds it (Billie shows it only once). */
const keys = new Map<string, string>();
async function keyFor(botId: string): Promise<string> {
  const had = keys.get(botId);
  const link = await db.query.blueprintLinks.findFirst({
    where: eq(blueprintLinks.botId, botId),
    columns: { keyId: true },
  });
  if (had && link && had.slice(3, 15) === link.keyId) return had;
  const key = await makeBlueprintKey(await makeUser("admin"), botId);
  keys.set(botId, key);
  return key;
}

async function auditCount(botId: string): Promise<number> {
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, botId), eq(auditLog.actorType, "system")));
  return rows.length;
}

function people() {
  const d = randomUUID().slice(0, 8);
  return { sam: `sam@acme-${d}.test`, jo: `jo@bolt-${d}.test`, ops: `ops@bolt-${d}.test` };
}

/** BluePrint's list, as it would send it. */
function sent(e: ReturnType<typeof people>, change: Partial<Record<string, unknown>> = {}) {
  const list = {
    exhibitors: [
      {
        id: "bp-1",
        company: "Acme Ltd",
        stand: "B12",
        name: "Sam Patel",
        emails: [e.sam],
        fields: {
          "Stand type": "Shell scheme",
          "Stand plan approved": false,
          "Credit notes": "Slow",
        },
      },
      {
        id: "bp-2",
        company: "Bolt & Co",
        stand: "C4",
        name: "Jo Bloggs",
        emails: [e.jo, e.ops],
        fields: { "Stand type": "Space only", "Stand plan approved": true },
      },
      ...((change.extra as object[]) ?? []),
    ].filter((x) => !(change.without as string[] | undefined)?.includes((x as { id: string }).id)),
  };
  const read = readSync(list);
  if (!read.ok) throw new Error(read.error);
  return read.list;
}

/** An exhibitor bot with BluePrint connected, its list sent, and personal answers on. */
async function connected() {
  const admin = await makeUser("admin");
  const { bot } = await makeBot();
  await db.update(bots).set({ personalAnswers: true }).where(eq(bots.id, bot.id));
  const key = await makeBlueprintKey(admin, bot.id);
  keys.set(bot.id, key);
  const e = people();
  await syncFromBlueprint(bot.id, sent(e));
  return { admin, key, e, bot: (await botById(bot.id))! };
}

describe.skipIf(!hasDb)("connecting BluePrint", () => {
  it("makes a key, keeps only what checks it, and replaces it on request", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const key = await makeBlueprintKey(admin, bot.id);
    const link = await db.query.blueprintLinks.findFirst({
      where: eq(blueprintLinks.botId, bot.id),
    });
    expect(link?.keyId).toBe(key.slice(3, 15));
    // Neither the key nor its secret part is kept.
    expect(JSON.stringify(link)).not.toContain(key.slice(16));
    expect(await botForKey(key)).toEqual({ botId: bot.id, keyId: link!.keyId });
    expect(await botForKey(`${key.slice(0, -2)}xx`)).toBeNull();
    expect(await botForKey(null)).toBeNull();
    expect((await blueprintStatus(bot.id))?.createdBy).toBe("Sam Tester");

    // A new key: the old one stops working at once.
    const next = await makeBlueprintKey(admin, bot.id);
    expect(await botForKey(key)).toBeNull();
    expect((await botForKey(next))?.botId).toBe(bot.id);
    await removeBlueprintKey(admin, bot.id);
    expect(await botForKey(next)).toBeNull();
    expect(await blueprintStatus(bot.id)).toBeNull();
    const audit = await db
      .select({ summary: auditLog.summary })
      .from(auditLog)
      .where(eq(auditLog.entityId, bot.id));
    expect(audit.map((a) => a.summary)).toEqual(
      expect.arrayContaining([
        "Connected BluePrint, the exhibitor manual",
        "Made a new BluePrint key (the old one stopped working)",
        "Disconnected BluePrint: its key stopped working",
      ]),
    );

    const { bot: visitors } = await makeBot({ audience: "visitors" });
    await expect(makeBlueprintKey(admin, visitors.id)).rejects.toThrow(/Only exhibitor bots/);
  });

  it("stops working when the bot is deleted", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const key = await makeBlueprintKey(admin, bot.id);
    await db.update(bots).set({ deletedAt: new Date() }).where(eq(bots.id, bot.id));
    expect(await botForKey(key)).toBeNull();
  });
});

describe.skipIf(!hasDb)("the exhibitor list from BluePrint", () => {
  it("replaces a spreadsheet, and keeps the team's hidden columns", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const e = people();
    const csv = Buffer.from(
      `Company,Stand,Email,Stand type,Stand plan approved\nOld Ltd,Z1,old@old.test,Shell scheme,No\n`,
    );
    await uploadList(admin, bot.id, { name: "old.csv", bytes: csv });
    await setHiddenColumns(admin, bot.id, ["Stand type"]);

    const result = await syncFromBlueprint(bot.id, sent(e));
    expect(result).toEqual({ exhibitors: 2, added: 2, updated: 0, removed: 1, skipped: 0 });
    const summary = await listSummary(bot.id);
    expect(summary).toMatchObject({
      fileName: "BluePrint",
      source: "blueprint",
      rows: 2,
      uploadedBy: null,
      columns: ["Stand type", "Stand plan approved", "Credit notes"],
      // Still hidden as the team chose; a new column that sounds internal starts hidden.
      hiddenColumns: ["Stand type", "Credit notes"],
    });
    expect(summary?.sample.map((s) => s.company)).toEqual(["Acme Ltd", "Bolt & Co"]);
  });

  it("updates in place: the same exhibitor keeps their row and their sign-in", async () => {
    const { bot, e } = await connected();
    const rows = () =>
      db
        .select({ id: exhibitors.id, externalId: exhibitors.externalId, stand: exhibitors.stand })
        .from(exhibitors)
        .where(eq(exhibitors.botId, bot.id));
    const before = new Map((await rows()).map((r) => [r.externalId, r.id]));

    // Sam signs in to a chat from the manual.
    const { conversation } = await startConversation({ bot, channel: "web" });
    const sam = await readManualSignIn(bot, signToken(await keyFor(bot.id), e.sam));
    expect(sam.ok).toBe(true);
    if (!sam.ok) return;
    await signInFromManual(bot, conversation.id, sam);
    // Jo too, in another chat.
    const { conversation: joChat } = await startConversation({ bot, channel: "web" });
    const jo = await readManualSignIn(bot, signToken(await keyFor(bot.id), e.jo));
    if (!jo.ok) throw new Error("jo");
    await signInFromManual(bot, joChat.id, jo);

    // Sam's stand changes, Bolt & Co leave, and a new exhibitor arrives.
    const next = sent(e, {
      without: ["bp-2"],
      extra: [{ id: "bp-3", company: "Northwind", stand: "D7", emails: ["alex@northwind.test"] }],
    });
    next.rows[0].stand = "B14";
    const auditBefore = await auditCount(bot.id);
    expect(await syncFromBlueprint(bot.id, next)).toEqual({
      exhibitors: 2,
      added: 1,
      updated: 1,
      removed: 1,
      skipped: 0,
    });
    const after = await rows();
    expect(after.find((r) => r.externalId === "bp-1")).toEqual({
      id: before.get("bp-1"),
      externalId: "bp-1",
      stand: "B14",
    });
    expect(after.map((r) => r.externalId).sort()).toEqual(["bp-1", "bp-3"]);
    // Sam is still signed in; Jo's sign-in ended with their row.
    const samChat = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(samChat?.exhibitorId).toBe(before.get("bp-1"));
    expect((await visitorUpdates(bot, samChat!, null)).signedIn).toMatchObject({ stand: "B14" });
    const joNow = await db.query.conversations.findFirst({
      where: eq(conversations.id, joChat.id),
    });
    expect(joNow?.exhibitorId).toBeNull();
    expect(await auditCount(bot.id)).toBe(auditBefore + 1);

    // The same list again changes nothing, and isn't audited again.
    expect(await syncFromBlueprint(bot.id, next)).toMatchObject({
      added: 0,
      updated: 0,
      removed: 0,
    });
    expect(await auditCount(bot.id)).toBe(auditBefore + 1);
    const link = await blueprintStatus(bot.id);
    expect(link?.lastSyncAt).toBeTruthy();
  });

  it("updates many exhibitors at once", async () => {
    const { bot } = await connected();
    const many = (stand: string) =>
      readSync({
        exhibitors: Array.from({ length: 700 }, (_, i) => ({
          id: `n${i}`,
          company: `Company ${i}`,
          stand: `${stand}${i}`,
          emails: [`person${i}@many-${bot.id.slice(0, 6)}.test`],
          fields: { "Stand type": i % 2 ? "Shell scheme" : "Space only" },
        })),
      });
    const first = many("A");
    const second = many("B");
    if (!first.ok || !second.ok) throw new Error("bad list");
    expect(await syncFromBlueprint(bot.id, first.list)).toMatchObject({ added: 700, removed: 2 });
    expect(await syncFromBlueprint(bot.id, second.list)).toMatchObject({
      added: 0,
      updated: 700,
      removed: 0,
    });
    const [row] = await db
      .select({ stand: exhibitors.stand, emails: exhibitors.emails, fields: exhibitors.fields })
      .from(exhibitors)
      .where(and(eq(exhibitors.botId, bot.id), eq(exhibitors.externalId, "n699")));
    expect(row).toEqual({
      stand: "B699",
      emails: [`person699@many-${bot.id.slice(0, 6)}.test`],
      fields: { "Stand type": "Shell scheme" },
    });
  });

  it("refuses an empty list and a bot that isn't for exhibitors", async () => {
    const { bot } = await connected();
    await expect(syncFromBlueprint(bot.id, { rows: [], columns: [], skipped: 3 })).rejects.toThrow(
      /nothing was changed/,
    );
    expect((await listSummary(bot.id))?.rows).toBe(2);
    await db.update(bots).set({ audience: "visitors" }).where(eq(bots.id, bot.id));
    await expect(syncFromBlueprint(bot.id, sent(people()))).rejects.toThrow(
      /isn't an exhibitor bot/,
    );
  });
});

describe.skipIf(!hasDb)("signing in from the exhibitor manual", () => {
  it("is open with BluePrint connected, a list and the setting on: no email needed", async () => {
    const { bot, admin } = await connected();
    expect(await signInOpen(bot)).toBe(false); // no codes without email sending
    expect(await manualSignInOpen(bot)).toBe(true);
    await db.update(bots).set({ personalAnswers: false }).where(eq(bots.id, bot.id));
    expect(await manualSignInOpen((await botById(bot.id))!)).toBe(false);
    await db.update(bots).set({ personalAnswers: true }).where(eq(bots.id, bot.id));
    await removeBlueprintKey(admin, bot.id);
    expect(await manualSignInOpen((await botById(bot.id))!)).toBe(false);
  });

  it("signs the chat in as the person BluePrint vouches for, and Billie answers from their row", async () => {
    const { bot, e } = await connected();
    const key = await keyFor(bot.id);
    const who = await readManualSignIn(bot, signToken(key, e.sam.toUpperCase()));
    expect(who).toMatchObject({ ok: true, email: e.sam });
    if (!who.ok) return;
    const { conversation } = await startConversation({ bot, channel: "web" });
    expect(await signInFromManual(bot, conversation.id, who)).toEqual({
      result: "signed_in",
      signedIn: { name: "Sam Patel", company: "Acme Ltd", stand: "B12" },
    });
    // Again: nothing changes.
    expect((await signInFromManual(bot, conversation.id, who)).result).toBe("already");
    const chat = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(chat).toMatchObject({ signedInEmail: e.sam, contact: { email: e.sam, stand: "B12" } });
    const notes = await db
      .select({ text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(notes.map((n) => n.text)).toEqual([
      "Signed in from the exhibitor manual as Sam Patel, Acme Ltd (stand B12). Ask about your own stand now.",
    ]);
    expect((await blueprintStatus(bot.id))?.lastSignInAt).toBeTruthy();

    const turn = await visitorMessage({
      bot,
      conversation: chat!,
      channel: "web",
      text: "Has our stand plan been approved?",
    });
    expect(turn.messages.at(-1)?.text).toContain("Stand plan approved: No");
    // The column the team keeps to itself never reaches Billie.
    expect(turn.messages.at(-1)?.text).not.toContain("Credit notes");
  });

  it("never signs someone in to a chat that belongs to another person", async () => {
    const { bot, e } = await connected();
    const key = await keyFor(bot.id);
    const sam = await readManualSignIn(bot, signToken(key, e.sam));
    const jo = await readManualSignIn(bot, signToken(key, e.jo));
    const ops = await readManualSignIn(bot, signToken(key, e.ops));
    if (!sam.ok || !jo.ok || !ops.ok) throw new Error("not listed");
    const { conversation } = await startConversation({ bot, channel: "web" });
    await signInFromManual(bot, conversation.id, jo);
    // Ops shares Jo's row, but is another person: they get a chat of their own.
    expect((await signInFromManual(bot, conversation.id, ops)).result).toBe("other");
    expect((await signInFromManual(bot, conversation.id, sam)).result).toBe("other");
    // Even once Jo's sign-in has run out.
    const later = new Date(Date.now() + 13 * 3600_000);
    expect((await signInFromManual(bot, conversation.id, sam, later)).result).toBe("other");
    // Jo, the next day: signed in again.
    expect((await signInFromManual(bot, conversation.id, jo, later)).result).toBe("signed_in");

    // A chat where someone left their email isn't anyone else's either.
    const { conversation: left } = await startConversation({ bot, channel: "web" });
    await db
      .update(conversations)
      .set({ contact: { name: "Kim", email: "Kim@Elsewhere.test" } })
      .where(eq(conversations.id, left.id));
    expect((await signInFromManual(bot, left.id, sam)).result).toBe("other");
    // Nor one where they left only a name and phone.
    const { conversation: phoned } = await startConversation({ bot, channel: "web" });
    await db
      .update(conversations)
      .set({ contact: { name: "Kim", phone: "07700 900123" } })
      .where(eq(conversations.id, phoned.id));
    expect((await signInFromManual(bot, phoned.id, sam)).result).toBe("other");
    // But one where Sam left their own email is Sam's.
    const { conversation: own } = await startConversation({ bot, channel: "web" });
    await db
      .update(conversations)
      .set({ contact: { name: "Sam", email: e.sam.toUpperCase() } })
      .where(eq(conversations.id, own.id));
    expect((await signInFromManual(bot, own.id, sam)).result).toBe("signed_in");
  });

  it("signs out an address BluePrint takes off a row, and nobody else on it", async () => {
    const { bot, e } = await connected();
    const key = await keyFor(bot.id);
    const jo = await readManualSignIn(bot, signToken(key, e.jo));
    const ops = await readManualSignIn(bot, signToken(key, e.ops));
    if (!jo.ok || !ops.ok) throw new Error("not listed");
    const { conversation: joChat } = await startConversation({ bot, channel: "web" });
    const { conversation: opsChat } = await startConversation({ bot, channel: "web" });
    await signInFromManual(bot, joChat.id, jo);
    await signInFromManual(bot, opsChat.id, ops);
    // Jo leaves Bolt & Co: BluePrint sends the row with only the ops address.
    const next = sent(e);
    next.rows[1].emails = [e.ops];
    expect(await syncFromBlueprint(bot.id, next)).toMatchObject({ updated: 1, removed: 0 });
    const chat = (id: string) =>
      db.query.conversations.findFirst({ where: eq(conversations.id, id) });
    expect((await visitorUpdates(bot, (await chat(joChat.id))!, null)).signedIn).toBeNull();
    expect((await chat(joChat.id))?.exhibitorId).toBeNull();
    expect((await visitorUpdates(bot, (await chat(opsChat.id))!, null)).signedIn).toMatchObject({
      company: "Bolt & Co",
    });
    // Even linked to the row again, a chat isn't signed in with an address no longer on it.
    await db
      .update(conversations)
      .set({ exhibitorId: (await chat(opsChat.id))!.exhibitorId })
      .where(eq(conversations.id, joChat.id));
    expect((await visitorUpdates(bot, (await chat(joChat.id))!, null)).signedIn).toBeNull();
    // And Billie doesn't answer Jo from the row.
    const turn = await visitorMessage({
      bot,
      conversation: (await chat(joChat.id))!,
      channel: "web",
      text: "Has our stand plan been approved?",
    });
    expect(turn.messages.at(-1)?.text).not.toContain("Stand plan approved");
  });

  it("refuses tokens it can't trust, and says why", async () => {
    const { bot, e } = await connected();
    const key = await keyFor(bot.id);
    expect(await readManualSignIn(bot, signToken(key, "stranger@nowhere.test"))).toEqual({
      ok: false,
      reason: "not_listed",
    });
    const old = signToken(key, e.sam, { now: Date.now() - 4 * 3600_000, seconds: 3600 });
    expect(await readManualSignIn(bot, old)).toEqual({ ok: false, reason: "expired" });
    expect(await readManualSignIn(bot, "nonsense")).toEqual({ ok: false, reason: "malformed" });
    // Another show's key never signs anyone in here, even for someone on this list.
    const other = await connected();
    const theirs = signToken(await keyFor(other.bot.id), e.sam);
    expect(await readManualSignIn(bot, theirs)).toEqual({ ok: false, reason: "unknown_key" });
    // A replaced key's sign-ins stop working.
    await makeBlueprintKey(other.admin, bot.id);
    expect(await readManualSignIn(bot, signToken(key, e.sam))).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });
});
