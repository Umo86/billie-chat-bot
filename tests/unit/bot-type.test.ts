import { describe, expect, it } from "vitest";
import { BOT_TYPES, defaultQuality, defaultRules, forNewType } from "@/lib/bots/defaults";

describe("the kind of chatbot", () => {
  it("says where each kind goes and what it asks for outside working hours", () => {
    expect(BOT_TYPES.exhibitors.label).toBe("Exhibitor chatbot");
    expect(BOT_TYPES.exhibitors.where).toBe("In BluePrint, the exhibitor manual");
    expect(BOT_TYPES.exhibitors.outOfHours).toContain("stand number");
    expect(BOT_TYPES.visitors.label).toBe("Visitor chatbot");
    expect(BOT_TYPES.visitors.where).toBe("On the event website");
    expect(BOT_TYPES.visitors.outOfHours).toContain("phone number");
  });

  it("swaps only what was still the old kind's default", () => {
    const onDefaults = { rules: defaultRules("exhibitors"), quality: defaultQuality("exhibitors") };
    expect(forNewType("exhibitors", "visitors", onDefaults)).toEqual({
      rules: { ...defaultRules("exhibitors"), ...pick(defaultRules("visitors")) },
      quality: "fast",
    });
    // The same fields in another order still count as the default.
    const reordered = {
      rules: { ...defaultRules("exhibitors"), collect: ["stand", "name", "email"] as const },
      quality: "fast" as const,
    };
    const next = forNewType("exhibitors", "visitors", {
      rules: { ...reordered.rules, collect: [...reordered.rules.collect] },
      quality: reordered.quality,
    });
    expect(next.rules.collect).toEqual(["name", "email", "phone"]);
    // Chosen by the team: kept, as are the hours and the promise.
    const chosen = {
      rules: {
        ...defaultRules("exhibitors"),
        collect: ["name", "company", "email"] as ("name" | "company" | "email")[],
        alwaysHuman: ["Complaints"],
        hours: { days: [1, 2, 3], start: "08:00", end: "18:00" },
      },
      quality: "fast" as const,
    };
    expect(forNewType("exhibitors", "visitors", chosen)).toEqual(chosen);
    expect(forNewType("visitors", "visitors", onDefaults)).toBe(onDefaults);
  });
});

function pick(r: ReturnType<typeof defaultRules>) {
  return { collect: r.collect, alwaysHuman: r.alwaysHuman };
}
