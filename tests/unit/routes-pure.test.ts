import { describe, expect, it } from "vitest";
import { matchRoute, wordList, type HandoverRoute } from "@/lib/conversations/routes";

const ROUTES: HandoverRoute[] = [
  { id: "r1", topic: "Electrics", words: ["electric", "power", "socket"], userId: "u-sparky" },
  { id: "r2", topic: "Deliveries", words: ["delivery", "unload", "forklift"], userId: "u-depot" },
  { id: "r3", topic: "Stand build", words: ["stand plan", "power"], userId: "u-build" },
];

describe("who handles what", () => {
  it("finds the topic by its words, at the start of a word", () => {
    expect(matchRoute(ROUTES, ["Can we get extra electrics?"])?.topic).toBe("Electrics");
    expect(matchRoute(ROUTES, ["When can we UNLOAD the van?"])?.topic).toBe("Deliveries");
    // "power" alone matches two topics: the first wins on a tie.
    expect(matchRoute(ROUTES, ["Is there power?"])?.topic).toBe("Electrics");
    // More words found wins.
    expect(matchRoute(ROUTES, ["Our stand plan needs power"])?.topic).toBe("Stand build");
    // Not inside other words.
    expect(matchRoute(ROUTES, ["We're empowered and ready"])).toBeNull();
    expect(matchRoute(ROUTES, ["Where do we park?"])).toBeNull();
    expect(matchRoute([], ["electric"])).toBeNull();
  });

  it("reads the words the team types", () => {
    expect(wordList("Electric, POWER; socket\nelectric, ")).toEqual([
      "electric",
      "power",
      "socket",
    ]);
  });
});
