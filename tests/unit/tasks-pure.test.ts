import { describe, expect, it } from "vitest";
import {
  cleanOrder,
  fromTemplate,
  money,
  offerFor,
  openTo,
  orderAnswers,
  REQUEST_TEMPLATES,
} from "@/lib/requests/rules";
import type { RequestType } from "@/lib/types";

const electrics: RequestType = {
  id: "elec0001",
  name: "Electrics order",
  when: "They want electrics for a space only stand.",
  handlerId: null,
  task: true,
  forColumn: "Stand type",
  forValues: ["Space only"],
  items: [
    { id: "sock0001", name: "16A single socket", price: 120 },
    { id: "lamp0001", name: "Floodlight", price: 45.5 },
  ],
  fields: [],
};
const row = (standType: string) => ({
  fields: { "Stand type": standType },
  stand: "B12",
  company: "Acme",
});

describe("tasks from the exhibitor manual", () => {
  it("are only for the stands they're set for, and need the exhibitor signed in", () => {
    expect(openTo(electrics, row("Space only"))).toBe("yes");
    expect(openTo(electrics, row(" space ONLY "))).toBe("yes");
    expect(openTo(electrics, row("Shell scheme"))).toBe("no");
    expect(openTo(electrics, null)).toBe("sign_in");
    expect(openTo({ ...electrics, forColumn: null }, null)).toBe("yes");
  });

  it("works out an order at the team's prices, whatever the page sent", () => {
    const { order, error } = cleanOrder(electrics, { sock0001: 2, lamp0001: "3", other: 50 });
    expect(error).toBeNull();
    expect(order).toEqual({
      lines: [
        { name: "16A single socket", quantity: 2, price: 120 },
        { name: "Floodlight", quantity: 3, price: 45.5 },
      ],
      total: 376.5,
    });
    expect(orderAnswers(order!).at(-1)).toEqual({
      label: "Total",
      value: "£376.50 (invoiced through BluePrint)",
    });
    expect(cleanOrder(electrics, {}).error).toBe("Choose how many of at least one item.");
    expect(cleanOrder(electrics, { sock0001: 1.5 }).error).toMatch(/between 0 and 99/);
    expect(cleanOrder(electrics, { sock0001: 500 }).error).toMatch(/between 0 and 99/);
    expect(cleanOrder({ ...electrics, items: [] }, {})).toEqual({ order: null, error: null });
    expect(money(1234.5)).toBe("£1,234.50");
  });

  it("offers the form with its items, and what Billie already knows", () => {
    const offer = offerFor([electrics], "elec0001", { name: "Sam", stand: "B12" });
    expect(offer?.items).toHaveLength(2);
    expect(offer?.known).toEqual({ name: "Sam", stand: "B12" });
  });

  it("has ready-made tasks: electrics for space only, the nameboard for shell scheme", () => {
    const made = REQUEST_TEMPLATES.filter((t) => t.task).map(fromTemplate);
    expect(made.map((t) => [t.name, t.forValues])).toEqual([
      ["Electrics order", ["Space only"]],
      ["Nameboard", ["Shell scheme"]],
    ]);
    expect(made.every((t) => /^[a-z0-9]{8}$/.test(t.id))).toBe(true);
  });
});
