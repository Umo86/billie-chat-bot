import { describe, expect, it } from "vitest";
import {
  cleanAnswers,
  fromTemplate,
  offerFor,
  REQUEST_CONTACT,
  REQUEST_TEMPLATES,
  requestFrom,
  requestRef,
  showValue,
} from "@/lib/requests/rules";
import { answerSystem } from "@/lib/ai/prompts";
import { fakeStructured } from "@/lib/ai/fake";
import type { RequestType } from "@/lib/types";

const hours: RequestType = {
  id: "hours001",
  name: "Extra build-up or breakdown hours",
  when: "They need to work outside the published hours.",
  handlerId: null,
  fields: [
    { id: "when0001", label: "Which days and times", kind: "long", required: true },
    { id: "date0001", label: "First day", kind: "date", required: false },
    { id: "why00001", label: "Why you need them", kind: "short", required: false },
  ],
};

describe("requests from chat", () => {
  it("offers the form for one of the bot's own requests only", () => {
    expect(offerFor([hours], "hours001")).toEqual({
      typeId: "hours001",
      name: "Extra build-up or breakdown hours",
      fields: hours.fields,
      contact: REQUEST_CONTACT,
    });
    expect(offerFor([hours], "nope")).toBeNull();
    expect(offerFor([hours], null)).toBeNull();
  });

  it("checks the form: required answers, real dates, and labels kept with the answers", () => {
    expect(cleanAnswers(hours, {})).toEqual({
      answers: [],
      errors: { when0001: "Fill this in." },
    });
    expect(cleanAnswers(hours, { when0001: "  Wed till 22:00 ", date0001: "soon" }).errors).toEqual(
      { date0001: "Pick a date." },
    );
    expect(
      cleanAnswers(hours, { when0001: "Wed till 22:00", date0001: "2026-11-25", why00001: "" }),
    ).toEqual({
      answers: [
        { label: "Which days and times", value: "Wed till 22:00" },
        { label: "First day", value: "2026-11-25" },
      ],
      errors: {},
    });
  });

  it("shows dates, references and who it's from in plain words", () => {
    expect(showValue("2026-11-25")).toBe("Wednesday 25 November 2026");
    expect(showValue("Wednesday evening")).toBe("Wednesday evening");
    expect(requestRef(1001)).toBe("R-1001");
    expect(requestFrom({ company: "Acme Ltd", stand: "N3-210", name: "Sam" })).toBe(
      "Acme Ltd, stand N3-210, Sam",
    );
    expect(requestFrom({})).toBe("Someone");
  });

  it("makes ready-made requests with their own ids", () => {
    const a = fromTemplate(REQUEST_TEMPLATES[0]);
    const b = fromTemplate(REQUEST_TEMPLATES[0]);
    expect(a.id).not.toBe(b.id);
    expect(a.fields[0].id).toMatch(/^[a-z0-9]{8}$/);
    expect(a).toMatchObject({ name: "Extra build-up or breakdown hours", handlerId: null });
  });

  it("tells Claude which requests it can offer, and when", () => {
    const bot = {
      name: "Exhibitor Help",
      audience: "exhibitors" as const,
      showName: "Ideal Home Show Christmas 2026",
      tone: "friendly" as const,
      personality: "",
      emoji: false,
      alwaysHuman: [],
    };
    expect(answerSystem(bot)).toContain('Set "request" to an empty string.');
    const s = answerSystem({
      ...bot,
      requests: [{ id: "hours001", name: hours.name, when: hours.when }],
    });
    expect(s).toContain(
      "- hours001: Extra build-up or breakdown hours. Offer it when: They need to work outside the published hours.",
    );
    expect(s).toContain('set "request" to its id and "handover" to "none"');
  });

  it("the stand-in offers a request when someone asks for one, not when they ask about rules", () => {
    const ask = (question: string) =>
      fakeStructured({
        purpose: "answer",
        question,
        passages: [],
        alwaysHuman: [],
        requests: [{ id: "hours001", name: hours.name }],
      }) as { request: string; handover: string };
    expect(ask("We need extra hours on Wednesday evening")).toMatchObject({
      request: "hours001",
      handover: "none",
    });
    expect(ask("What are the build-up hours?").request).toBe("");
  });
});
