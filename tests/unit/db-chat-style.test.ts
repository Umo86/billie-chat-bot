import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { updateBot } from "@/lib/bots/service";
import { copyBot } from "@/lib/bots/copy";
import { answerBotFor, botById } from "@/lib/bots/load";
import { publicBot } from "@/lib/chat/public";
import { reuseKey } from "@/lib/ai/reuse";
import { hasDb, makeBot, makeUser } from "../helpers/db";

const LOGO = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

describe.skipIf(!hasDb)("a bot's chat style and branding (Postgres)", () => {
  it("saves the style, gives it to answers, and copies it to the next show", async () => {
    const editor = await makeUser("editor");
    const { bot } = await makeBot({ name: "Santa's Helper" });
    await updateBot(editor, bot.id, {
      tone: "friendly",
      answerLength: "short",
      personality: "Writes like Santa.",
      emoji: true,
      useName: false,
      avoidWords: "Unfortunately",
    });

    const row = (await botById(bot.id))!;
    expect(row).toMatchObject({
      answerLength: "short",
      useName: false,
      avoidWords: "Unfortunately",
    });
    const answering = await answerBotFor(row);
    expect(answering).toMatchObject({
      answerLength: "short",
      useName: false,
      avoidWords: "Unfortunately",
      personality: "Writes like Santa.",
    });
    const [audit] = await db
      .select({ summary: auditLog.summary })
      .from(auditLog)
      .where(eq(auditLog.entityId, bot.id));
    expect(audit.summary).toMatch(/answerLength/);

    const copyId = await copyBot(editor, bot.id, { name: "Santa's Helper 2027", showName: "2027" });
    expect(await botById(copyId)).toMatchObject({
      answerLength: "short",
      useName: false,
      avoidWords: "Unfortunately",
    });
  });

  it("brands the chat: logo, button colour and the chat button's words", async () => {
    const editor = await makeUser("editor");
    const { bot } = await makeBot({ status: "live" });
    // Not set: the header colour stands in for buttons, no logo, a plain icon.
    expect(await publicBot((await botById(bot.id))!)).toMatchObject({
      accent: "#0d6a5b",
      logoUrl: null,
      launcherLabel: "",
    });
    await updateBot(editor, bot.id, {
      color: "#b3121b",
      accentColor: "#146b3a",
      logoUrl: LOGO,
      launcherLabel: "Ask Santa",
    });
    expect(await publicBot((await botById(bot.id))!)).toMatchObject({
      color: "#b3121b",
      accent: "#146b3a",
      logoUrl: LOGO,
      launcherLabel: "Ask Santa",
    });
    const copyId = await copyBot(editor, bot.id, { name: "Copy", showName: "Next" });
    expect(await botById(copyId)).toMatchObject({
      accentColor: "#146b3a",
      logoUrl: LOGO,
      launcherLabel: "Ask Santa",
    });
  });

  it("a new style means fresh answers, not ones given again in the old style", async () => {
    const { bot } = await makeBot();
    const editor = await makeUser("editor");
    const keyOf = async () =>
      (
        await reuseKey(
          await answerBotFor((await botById(bot.id))!),
          "When does build-up start?",
          "web",
        )
      )?.key;
    const before = await keyOf();
    expect(before).toBeTruthy();
    expect(await keyOf()).toBe(before);
    await updateBot(editor, bot.id, { personality: "Writes like Santa." });
    expect(await keyOf()).not.toBe(before);
  });
});
