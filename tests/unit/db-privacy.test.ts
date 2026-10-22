import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { conversations, emailThreads, messages } from "@/lib/db/schema";
import { deletePerson, findPerson, parsePersonQuery } from "@/lib/privacy/requests";
import { hasDb, makeBot, makeUser } from "../helpers/db";

describe("privacy request search terms", () => {
  it("reads emails and UK phone numbers", () => {
    expect(parsePersonQuery(" Priya@Acme.co.uk ")).toEqual({
      kind: "email",
      value: "priya@acme.co.uk",
    });
    expect(parsePersonQuery("07700 900123")).toEqual({ kind: "phone", value: "447700900123" });
    expect(parsePersonQuery("+44 7700 900123")).toEqual({ kind: "phone", value: "447700900123" });
    expect(() => parsePersonQuery("hello")).toThrow(/email address or a phone number/);
  });
});

describe.skipIf(!hasDb)("privacy requests", () => {
  it("finds and deletes one person's chats, messages and emails, and nobody else's", async () => {
    const admin = await makeUser("admin");
    const { bot } = await makeBot();
    const tag = Math.random().toString(36).slice(2, 8);
    const email = `priya.${tag}@acme.test`;
    const phone = `4477009${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`;
    const [mine] = await db
      .insert(conversations)
      .values({
        botId: bot.id,
        channel: "web",
        contact: { name: "Priya", email: email.replace("priya", "Priya") },
      })
      .returning();
    await db.insert(messages).values({ conversationId: mine.id, role: "visitor", text: "Hello" });
    const [wa] = await db
      .insert(conversations)
      .values({ botId: bot.id, channel: "whatsapp", waId: phone })
      .returning();
    const [other] = await db
      .insert(conversations)
      .values({ botId: bot.id, channel: "web", contact: { email: "someone@else.test" } })
      .returning();
    await db.insert(emailThreads).values({ source: "manual", fromEmail: email, body: "Hi" });

    expect(await findPerson(email)).toMatchObject({ chats: 1, emails: 1 });
    expect(await findPerson(`0${phone.slice(2)}`)).toMatchObject({ chats: 1, emails: 0 });

    expect(await deletePerson(admin, email)).toEqual({ chats: 1, emails: 1 });
    expect(
      await db.query.conversations.findFirst({ where: eq(conversations.id, mine.id) }),
    ).toBeUndefined();
    expect(
      await db.query.messages.findFirst({ where: eq(messages.conversationId, mine.id) }),
    ).toBeUndefined();
    expect(
      await db.query.conversations.findFirst({ where: eq(conversations.id, other.id) }),
    ).toBeDefined();
    expect(
      await db.query.conversations.findFirst({ where: eq(conversations.id, wa.id) }),
    ).toBeDefined();
    expect(await findPerson(email)).toMatchObject({ chats: 0, emails: 0 });
  });
});
