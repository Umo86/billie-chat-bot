import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  auditLog,
  bots,
  conversations,
  exhibitorCodes,
  exhibitorLists,
  messages,
} from "@/lib/db/schema";
import {
  exhibitorByEmail,
  hasList,
  listSummary,
  removeList,
  signInOpen,
  uploadList,
} from "@/lib/exhibitors/service";
import {
  CODE_TRIES,
  dropEmptyConversation,
  requestCode,
  signOut,
  verifyCode,
} from "@/lib/exhibitors/sign-in";
import { startConversation, visitorMessage, visitorUpdates } from "@/lib/conversations/service";
import { botById } from "@/lib/bots/load";
import { publicBot } from "@/lib/chat/public";
import { writeSuggestion } from "@/lib/conversations/suggest";
import { deletePerson, exportPerson, findPerson } from "@/lib/privacy/requests";
import { runRetention } from "@/lib/privacy/retention";
import { hasDb, makeBot, makeUser } from "../helpers/db";

type Sent = { to: string | string[]; subject: string; text: string };
const sent = vi.hoisted(() => [] as Sent[]);
vi.mock("@/lib/email/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/send")>()),
  sendEmail: async (e: Sent) => {
    sent.push(e);
  },
}));

function csv(rows: string[][]): Buffer {
  return Buffer.from(
    rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n"),
  );
}

/** A list with its own addresses (other tests' lists share the database). */
function makeList() {
  const d = randomUUID().slice(0, 8);
  const e = { sam: `sam@acme-${d}.test`, jo: `jo@bolt-${d}.test`, ops: `ops@bolt-${d}.test` };
  const rows = [
    ["Company", "Stand", "Contact", "Email", "Stand type", "Stand plan approved"],
    ["Acme Ltd", "B12", "Sam Patel", e.sam.replace("sam@acme", "Sam@Acme"), "Shell scheme", "No"],
    ["Bolt & Co", "C4", "Jo Bloggs", `${e.jo}; ${e.ops}`, "Space only", "Yes"],
    ["Nobody Ltd", "D1", "Kim", "", "Shell scheme", ""],
  ];
  return { e, rows };
}
const LIST = makeList().rows;

/** An exhibitor bot with a list uploaded and signing in switched on. */
async function signInBot() {
  const admin = await makeUser("admin");
  const { bot } = await makeBot();
  const { e, rows } = makeList();
  await uploadList(admin, bot.id, { name: "exhibitors.csv", bytes: csv(rows) });
  await db.update(bots).set({ personalAnswers: true }).where(eq(bots.id, bot.id));
  return { admin, e, bot: (await botById(bot.id))! };
}

/** The code in the last email sent. */
function lastCode(): string {
  return /\b(\d{6})\b/.exec(sent.at(-1)!.text)![1];
}

describe.skipIf(!hasDb)("exhibitor lists", () => {
  it("only takes a list with an email column, on an exhibitor bot", async () => {
    const admin = await makeUser("admin");
    const { bot: visitors } = await makeBot({ audience: "visitors" });
    await expect(
      uploadList(admin, visitors.id, { name: "list.csv", bytes: csv(LIST) }),
    ).rejects.toThrow(/Only exhibitor bots/);
    const { bot } = await makeBot();
    await expect(
      uploadList(admin, bot.id, {
        name: "list.csv",
        bytes: csv([
          ["Company", "Stand"],
          ["Acme", "B12"],
        ]),
      }),
    ).rejects.toThrow(/No email column/);
    await expect(
      uploadList(admin, bot.id, { name: "list.pdf", bytes: Buffer.from("%PDF") }),
    ).rejects.toThrow(/Excel \(\.xlsx\) or CSV/);
    expect(await hasList(bot.id)).toBe(false);
  });

  it("replaces the whole list with each upload, and audits it", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const { e, rows } = makeList();
    const first = await uploadList(admin, bot.id, { name: "first.csv", bytes: csv(rows) });
    expect(first).toMatchObject({
      fileName: "first.csv",
      rows: 2,
      skipped: 1,
      columns: ["Stand type", "Stand plan approved"],
      uploadedBy: "Sam Tester",
    });
    expect(first.sample.map((s) => s.company)).toEqual(["Acme Ltd", "Bolt & Co"]);
    expect((await exhibitorByEmail(bot.id, ` ${e.ops.toUpperCase()} `))?.company).toBe("Bolt & Co");

    await uploadList(admin, bot.id, { name: "second.csv", bytes: csv([rows[0], rows[1]]) });
    expect(await listSummary(bot.id)).toMatchObject({ fileName: "second.csv", rows: 1 });
    expect(await exhibitorByEmail(bot.id, e.jo)).toBeNull();

    await removeList(admin, bot.id);
    expect(await hasList(bot.id)).toBe(false);
    expect(await exhibitorByEmail(bot.id, e.sam)).toBeNull();
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, bot.id));
    expect(audit.map((a) => a.summary)).toEqual(
      expect.arrayContaining([
        "Uploaded the exhibitor list (2 exhibitors, 1 row without an email left out)",
        "Uploaded the exhibitor list (1 exhibitor)",
        "Removed the exhibitor list",
      ]),
    );
  });
});

describe.skipIf(!hasDb)("exhibitors signing in to the chat", () => {
  beforeAll(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test_not_real");
    vi.stubEnv("EMAIL_FROM", "Billie <billie@media10.test>");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("is open only with the setting on, a list and email sending", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    await db.update(bots).set({ personalAnswers: true }).where(eq(bots.id, bot.id));
    expect(await signInOpen((await botById(bot.id))!)).toBe(false); // no list yet
    await uploadList(admin, bot.id, { name: "list.csv", bytes: csv(LIST) });
    const ready = (await botById(bot.id))!;
    expect(await signInOpen(ready)).toBe(true);
    expect(await publicBot(ready)).toMatchObject({ signIn: true });
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await signInOpen(ready)).toBe(false);
    vi.stubEnv("RESEND_API_KEY", "re_test_not_real");
    await db.update(bots).set({ personalAnswers: false }).where(eq(bots.id, bot.id));
    const off = (await botById(bot.id))!;
    expect(await signInOpen(off)).toBe(false);
    await expect(requestCode(off, randomUUID(), "sam@acme.test")).rejects.toThrow(
      /isn't available/,
    );
  });

  it("sends a code only to an email on the list, and answers the same either way", async () => {
    const { bot, e } = await signInBot();
    const { conversation } = await startConversation({ bot, channel: "web" });
    sent.length = 0;
    const stranger = await requestCode(bot, conversation.id, "stranger@else.test");
    expect(stranger).toMatch(/^If that email is on the exhibitor list/);
    expect(sent).toHaveLength(0);
    expect(await requestCode(bot, conversation.id, e.sam.toUpperCase())).toBe(stranger);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(e.sam);
    expect(sent[0].subject).toContain(lastCode());
    // Only a hash is kept.
    const [row] = await db
      .select()
      .from(exhibitorCodes)
      .where(eq(exhibitorCodes.conversationId, conversation.id));
    expect(row.codeHash).not.toContain(lastCode());
  });

  it("signs the chat in with the right code, and Billie answers from their record", async () => {
    const { bot, e } = await signInBot();
    const { conversation } = await startConversation({ bot, channel: "web" });
    await requestCode(bot, conversation.id, e.sam);
    const code = lastCode();
    await expect(
      verifyCode(bot, conversation.id, code === "000000" ? "111111" : "000000"),
    ).rejects.toThrow(/isn't right/);
    // Typed loosely, with a space.
    const who = await verifyCode(bot, conversation.id, `${code.slice(0, 3)} ${code.slice(3)}`);
    expect(who).toEqual({ name: "Sam Patel", company: "Acme Ltd", stand: "B12" });
    // A code works once.
    await expect(verifyCode(bot, conversation.id, code)).rejects.toThrow(/run out/);

    const signedIn = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(signedIn?.exhibitorId).toBeTruthy();
    expect(signedIn?.contact).toMatchObject({
      name: "Sam Patel",
      company: "Acme Ltd",
      stand: "B12",
      email: e.sam,
    });
    const updates = await visitorUpdates(bot, signedIn!, null);
    expect(updates.signedIn).toEqual(who);
    expect(updates.messages.at(-1)?.text).toBe(
      "Signed in as Sam Patel, Acme Ltd (stand B12). Ask about your own stand now.",
    );

    // The stand-in AI quotes the passage that best matches: here, their own record.
    const turn = await visitorMessage({
      bot,
      conversation: signedIn!,
      channel: "web",
      text: "Has our stand plan been approved?",
    });
    const answer = turn.messages.at(-1)!;
    expect(answer.text).toContain("Stand plan approved: No");
    expect(answer.sources).toEqual([expect.objectContaining({ title: "Your exhibitor record" })]);

    // The team's suggested reply gets their record too.
    await writeSuggestion(conversation.id);
    const withSuggestion = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(withSuggestion?.suggestion?.text).toContain("Stand plan approved: No");

    await signOut(conversation.id);
    const out = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(out?.exhibitorId).toBeNull();
    expect((await visitorUpdates(bot, out!, null)).signedIn).toBeNull();
    // Signed out, another question doesn't get their record.
    const after = await visitorMessage({
      bot,
      conversation: out!,
      channel: "web",
      text: "Has our stand plan been approved?",
    });
    expect(after.messages.at(-1)?.text).not.toContain("Stand plan approved");
  });

  it("stops a code after too many wrong tries", async () => {
    const { bot, e } = await signInBot();
    const { conversation } = await startConversation({ bot, channel: "web" });
    await requestCode(bot, conversation.id, e.jo);
    const code = lastCode();
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < CODE_TRIES; i++)
      await expect(verifyCode(bot, conversation.id, wrong)).rejects.toThrow(/isn't right/);
    await expect(verifyCode(bot, conversation.id, code)).rejects.toThrow(/Too many tries/);
    // A code from another chat doesn't work here.
    const other = await startConversation({ bot, channel: "web" });
    await requestCode(bot, other.conversation.id, e.jo);
    await expect(verifyCode(bot, conversation.id, lastCode())).rejects.toThrow();
  });

  it("drops an empty chat that signing in started, but never one with messages", async () => {
    const { bot } = await signInBot();
    const empty = await startConversation({ bot, channel: "web" });
    await dropEmptyConversation(empty.conversation.id);
    expect(
      await db.query.conversations.findFirst({
        where: eq(conversations.id, empty.conversation.id),
      }),
    ).toBeUndefined();
    const used = await startConversation({ bot, channel: "web" });
    await db
      .insert(messages)
      .values({ conversationId: used.conversation.id, role: "visitor", text: "Hello" });
    await dropEmptyConversation(used.conversation.id);
    expect(
      await db.query.conversations.findFirst({ where: eq(conversations.id, used.conversation.id) }),
    ).toBeTruthy();
  });

  it("finds, exports and deletes an exhibitor's row for a privacy request", async () => {
    const { admin, bot, e } = await signInBot();
    const { conversation } = await startConversation({ bot, channel: "web" });
    await requestCode(bot, conversation.id, e.ops);
    await verifyCode(bot, conversation.id, lastCode());
    // Searching by their second address finds the row and the chat they signed in to.
    expect(await findPerson(e.ops.toUpperCase())).toMatchObject({ exhibitors: 1, chats: 1 });
    const copy = await exportPerson(admin, e.ops);
    expect(copy.exhibitorLists).toEqual([
      expect.objectContaining({
        bot: bot.name,
        company: "Bolt & Co",
        emails: [e.jo, e.ops],
        fields: { "Stand type": "Space only", "Stand plan approved": "Yes" },
      }),
    ]);
    expect(await deletePerson(admin, e.ops)).toMatchObject({ exhibitors: 1, chats: 1 });
    expect(await exhibitorByEmail(bot.id, e.jo)).toBeNull();
    expect(await exhibitorByEmail(bot.id, e.sam)).toBeTruthy();
    // The list's count stays right.
    expect((await listSummary(bot.id))?.rows).toBe(1);
  });

  it("clears old codes, and lists nobody has uploaded again within the retention time", async () => {
    const { bot, e } = await signInBot();
    const { conversation } = await startConversation({ bot, channel: "web" });
    await requestCode(bot, conversation.id, e.sam);
    await db
      .update(exhibitorCodes)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(exhibitorCodes.conversationId, conversation.id));
    await db
      .update(exhibitorLists)
      .set({ uploadedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(exhibitorLists.botId, bot.id));
    const counts = await runRetention();
    expect(counts.exhibitorLists).toBeGreaterThanOrEqual(1);
    expect(await hasList(bot.id)).toBe(false);
    expect(await exhibitorByEmail(bot.id, e.sam)).toBeNull();
    expect(
      await db
        .select()
        .from(exhibitorCodes)
        .where(and(eq(exhibitorCodes.conversationId, conversation.id))),
    ).toHaveLength(0);
  });
});
