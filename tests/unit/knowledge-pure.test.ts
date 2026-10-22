import { describe, expect, it } from "vitest";
import { chunkSegments, MAX_PASSAGE } from "@/lib/knowledge/chunk";
import { fuseRankings, searchTerms } from "@/lib/knowledge/rank";
import { questionKey } from "@/lib/knowledge/gaps";
import { orQuery } from "@/lib/knowledge/search";

describe("chunking", () => {
  it("keeps each passage within the limit and never mixes labels", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about deliveries and badges.`).join(" ");
    const chunks = chunkSegments([
      { text: `Intro paragraph.\n\n${long}`, label: "p. 1" },
      { text: "Second page text.", label: "p. 2" },
    ]);
    expect(chunks.every((c) => c.text.length <= MAX_PASSAGE * 1.2)).toBe(true);
    expect(chunks.filter((c) => c.label === "p. 2").map((c) => c.text)).toEqual(["Second page text."]);
    expect(chunks.filter((c) => c.label === "p. 1").length).toBeGreaterThan(1);
  });

  it("splits a single huge sentence and drops empty segments", () => {
    const chunks = chunkSegments([
      { text: "x".repeat(2500), label: "" },
      { text: "   \n\n  ", label: "empty" },
    ]);
    expect(chunks.map((c) => c.text.length)).toEqual([1100, 1100, 300]);
  });

  it("joins a short tail onto the passage before it", () => {
    const para = "a".repeat(1000);
    const chunks = chunkSegments([{ text: `${para}\n\nShort tail.`, label: "p. 3" }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text.endsWith("Short tail.")).toBe(true);
  });
});

describe("ranking", () => {
  it("fuses keyword and meaning results, rewarding agreement", () => {
    const fused = fuseRankings([
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ id: "c" }, { id: "a" }],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b"]);
  });

  it("lets typed answers win close calls", () => {
    const fused = fuseRankings([[{ id: "file" }, { id: "typed", boost: 0.3 }]]);
    expect(fused[0].id).toBe("typed");
  });

  it("extracts search words with synonyms and singulars", () => {
    const terms = searchTerms("Where do deliveries go?");
    expect(terms).toEqual(expect.arrayContaining(["deliveries", "delivery", "venue"]));
    expect(terms).not.toContain("do");
    expect(searchTerms("the and of")).toEqual([]);
  });

  it("builds a safe OR query for Postgres", () => {
    expect(orQuery("Badges: how many?!")).toBe("badges | badge | pass | lanyard | registration | many");
    expect(orQuery("'); DROP TABLE x; --")).toBe("drop | table");
    expect(orQuery("??")).toBeNull();
  });
});

describe("gaps", () => {
  it("groups the same question however it is typed", () => {
    expect(questionKey("Is there a crèche?")).toBe(questionKey("is there   creche"));
    expect(questionKey("Hi! Is there a crèche, please?")).toBe("is there creche");
  });
});
