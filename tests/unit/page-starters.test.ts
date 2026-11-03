import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots } from "@/lib/db/schema";
import { cleanPageRules, startersForPage } from "@/lib/bots/page-starters";
import { publicBot } from "@/lib/chat/public";
import { botById } from "@/lib/bots/load";
import { hasDb, makeBot } from "../helpers/db";

const RULES = [
  { match: "/Travel", starters: ["Where can I park?", "Is there a shuttle bus?"] },
  { match: "/exhibit/deliveries", starters: ["When can we unload?"] },
  { match: "/checkout", starters: [] },
];
const USUAL = ["When does the show open?"];

describe("starters for some pages", () => {
  it("uses the first rule the page address contains, ignoring case", () => {
    expect(startersForPage(RULES, USUAL, "https://ukcw.com/visit/travel")).toEqual([
      "Where can I park?",
      "Is there a shuttle bus?",
    ]);
    expect(startersForPage(RULES, USUAL, "https://ukcw.com/exhibit/Deliveries")).toEqual([
      "When can we unload?",
    ]);
    // A rule with no questions shows none there.
    expect(startersForPage(RULES, USUAL, "https://ukcw.com/checkout")).toEqual([]);
    // Anywhere else, and the chat page (no website page), get the usual ones.
    expect(startersForPage(RULES, USUAL, "https://ukcw.com/")).toEqual(USUAL);
    expect(startersForPage(RULES, USUAL, null)).toEqual(USUAL);
  });

  it("tidies rules for saving", () => {
    expect(
      cleanPageRules([
        { match: "  /travel ", starters: [" Where can I park? ", "", "a", "b"] },
        { match: "   ", starters: ["Lost"] },
      ]),
    ).toEqual([{ match: "/travel", starters: ["Where can I park?", "a", "b"] }]);
  });
});

describe.skipIf(!hasDb)("starters for some pages (Postgres)", () => {
  it("go to the chat on a matching page of the website", async () => {
    const { bot } = await makeBot();
    await db.update(bots).set({ starters: USUAL, pageStarters: RULES }).where(eq(bots.id, bot.id));
    const fresh = (await botById(bot.id))!;
    expect((await publicBot(fresh, "https://ukcw.com/travel")).starters).toEqual([
      "Where can I park?",
      "Is there a shuttle bus?",
    ]);
    expect((await publicBot(fresh)).starters).toEqual(USUAL);
  });
});
