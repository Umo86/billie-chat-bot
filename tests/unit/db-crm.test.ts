import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots, chatRequests, jobs } from "@/lib/db/schema";
import { submitRequest, visitorMessage } from "@/lib/conversations/service";
import { botById } from "@/lib/bots/load";
import { resendLead, sendLead } from "@/lib/crm/leads";
import { requestDetail } from "@/lib/requests/service";
import { fromTemplate, offerFor, VISITOR_REQUEST_TEMPLATES } from "@/lib/requests/rules";
import { hasDb, makeBot, makeUser } from "../helpers/db";

/**
 * A stand-in Twenty: its REST API in memory, answering like the real one
 * (filters such as emails.primaryEmail[eq]:"x", { data: { createPerson } }).
 */
type Rec = Record<string, unknown> & { id: string };
const twenty = vi.hoisted(() => ({
  store: {} as Record<string, Rec[]>,
  calls: [] as { method: string; path: string; body?: unknown; auth: string | null }[],
  fail: null as null | { status: number; message?: string },
}));

function filterHit(rec: Rec, filter: string): boolean {
  const m = /^(.+)\[(eq|ilike)\]:"(.*)"$/.exec(filter);
  if (!m) throw new Error(`bad filter ${filter}`);
  const [, path, op, raw] = m;
  let v: unknown = rec;
  for (const k of path.split(".")) v = (v as Record<string, unknown> | undefined)?.[k];
  const value = String(v ?? "").toLowerCase();
  const want = raw.toLowerCase();
  if (op === "eq") return value === want;
  const re = new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
  return re.test(value);
}

async function fakeTwenty(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const auth = new Headers(init.headers).get("authorization");
  const path = url.pathname.replace(/^\/rest\//, "");
  twenty.calls.push({ method, path, body, auth });
  if (twenty.fail)
    return Response.json(
      { message: twenty.fail.message ?? "nope" },
      { status: twenty.fail.status },
    );
  const [plural, id] = path.split("/");
  const list = (twenty.store[plural] ??= []);
  if (method === "GET") {
    const filter = url.searchParams.get("filter");
    const found = filter ? list.filter((r) => filterHit(r, filter)) : list;
    return Response.json({
      data: { [plural]: found.slice(0, Number(url.searchParams.get("limit") ?? 50)) },
    });
  }
  if (method === "PATCH") {
    const rec = list.find((r) => r.id === id)!;
    Object.assign(rec, body);
    return Response.json({ data: { updatePerson: rec } });
  }
  const singular = {
    people: "person",
    companies: "company",
    opportunities: "opportunity",
    notes: "note",
    noteTargets: "noteTarget",
  }[plural]!;
  const rec = { id: `${singular}-${list.length + 1}`, ...body } as Rec;
  list.push(rec);
  return Response.json(
    { data: { [`create${singular[0].toUpperCase()}${singular.slice(1)}`]: rec } },
    { status: 201 },
  );
}

async function leadBot() {
  const { bot } = await makeBot({ audience: "visitors", name: "Visitor Help" });
  const lead = fromTemplate(VISITOR_REQUEST_TEMPLATES[0]);
  await db
    .update(bots)
    .set({ requestTypes: [lead] })
    .where(eq(bots.id, bot.id));
  return { bot: (await botById(bot.id))!, lead };
}

async function sendForm(
  bot: NonNullable<Awaited<ReturnType<typeof botById>>>,
  lead: ReturnType<typeof fromTemplate>,
  contact: Record<string, string>,
) {
  const turn = await visitorMessage({
    bot,
    conversation: null,
    channel: "web",
    text: "Hello",
    pageUrl: "https://www.ukcw.test/exhibit",
  });
  await submitRequest(
    bot,
    turn.conversationId,
    lead,
    [{ label: "What does your company do or sell?", value: "Timber frames" }],
    contact,
  );
  const [r] = await db
    .select()
    .from(chatRequests)
    .where(eq(chatRequests.conversationId, turn.conversationId));
  return r;
}

describe.skipIf(!hasDb)("leads to Twenty CRM (Postgres, stand-in Twenty)", () => {
  beforeEach(() => {
    twenty.store = {};
    twenty.calls = [];
    twenty.fail = null;
    process.env.TWENTY_API_KEY = "test-twenty-key";
    process.env.TWENTY_API_URL = "https://twenty.example.test/";
    process.env.TWENTY_APP_URL = "https://app.twenty.example.test";
    vi.stubGlobal("fetch", vi.fn(fakeTwenty));
  });
  afterEach(() => {
    delete process.env.TWENTY_API_KEY;
    delete process.env.TWENTY_API_URL;
    delete process.env.TWENTY_APP_URL;
    vi.unstubAllGlobals();
  });

  it("the exhibiting form asks no stand and says where the details go", () => {
    const lead = fromTemplate(VISITOR_REQUEST_TEMPLATES[0]);
    const offer = offerFor([lead], lead.id, "visitors")!;
    expect(offer.contact).toEqual(["name", "company", "email", "phone"]);
    expect(offer.promise).toMatch(/sales team/);
    expect(lead.crm).toBe(true);
  });

  it("makes the company, the person, an opportunity and a note, once", async () => {
    const { bot, lead } = await leadBot();
    const r = await sendForm(bot, lead, {
      name: "Sam de la Cruz",
      company: "Acme Frames Ltd",
      email: "Sam@AcmeFrames.co.uk",
      phone: "07700 900123",
    });
    expect(r.crmStatus).toBe("queued");
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, `crm-lead:${r.id}`));
    expect(job.kind).toBe("crm_lead");

    await sendLead(r.id);
    const s = twenty.store;
    expect(s.companies).toEqual([
      expect.objectContaining({
        name: "Acme Frames Ltd",
        domainName: { primaryLinkUrl: "https://acmeframes.co.uk" },
      }),
    ]);
    expect(s.people).toEqual([
      expect.objectContaining({
        name: { firstName: "Sam", lastName: "de la Cruz" },
        emails: { primaryEmail: "sam@acmeframes.co.uk" },
        phones: {
          primaryPhoneNumber: "7700900123",
          primaryPhoneCountryCode: "GB",
          primaryPhoneCallingCode: "+44",
        },
        companyId: s.companies[0].id,
      }),
    ]);
    expect(s.opportunities).toEqual([
      expect.objectContaining({
        name: "Acme Frames Ltd – exhibiting at UKCW London 2027",
        companyId: s.companies[0].id,
        pointOfContactId: s.people[0].id,
      }),
    ]);
    const note = s.notes[0] as unknown as { title: string; bodyV2: { markdown: string } };
    expect(note.title).toMatch(/^Exhibiting enquiry from the Visitor Help chat \(R-\d+\)$/);
    expect(note.bodyV2.markdown).toContain("Timber frames");
    expect(note.bodyV2.markdown).toContain("https://www.ukcw.test/exhibit");
    expect(s.noteTargets).toHaveLength(3);
    // The key goes in the header, to the team's own Twenty.
    expect(twenty.calls.every((c) => c.auth === "Bearer test-twenty-key")).toBe(true);

    const done = (await db.query.chatRequests.findFirst({ where: eq(chatRequests.id, r.id) }))!;
    expect(done).toMatchObject({ crmStatus: "sent", crmNote: "" });
    expect((await requestDetail(r.id))!.crm).toMatchObject({
      status: "sent",
      url: `https://app.twenty.example.test/object/opportunity/${s.opportunities[0].id}`,
    });

    // Run again (a retried job): nothing more is made.
    const before = twenty.calls.length;
    await sendLead(r.id);
    expect(twenty.calls.length).toBe(before);

    // The same person asking again later: found by email, not made twice.
    const again = await sendForm(bot, lead, {
      name: "Sam de la Cruz",
      company: "Acme Frames Ltd",
      email: "sam@acmeframes.co.uk",
    });
    await sendLead(again.id);
    expect(s.people).toHaveLength(1);
    expect(s.companies).toHaveLength(1);
    expect(s.opportunities).toHaveLength(2);
  });

  it("a free email address makes no company web address; a refused number doesn't lose the lead", async () => {
    const { bot, lead } = await leadBot();
    const r = await sendForm(bot, lead, {
      name: "Jo",
      company: "Jo's Kitchens",
      email: "jo.kitchens@gmail.com",
      phone: "+33 6 12 34 56 78",
    });
    // This Twenty refuses phone numbers without their country.
    const real = fakeTwenty;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        if (String(input).endsWith("/rest/people") && init.method === "POST" && body.phones)
          return Response.json({ message: "Invalid phone" }, { status: 400 });
        return real(input, init);
      }),
    );
    await sendLead(r.id);
    expect(twenty.store.companies[0]).toEqual(expect.objectContaining({ name: "Jo's Kitchens" }));
    expect(twenty.store.companies[0].domainName).toBeUndefined();
    expect(twenty.store.people[0].phones).toBeUndefined();
    expect(twenty.store.people[0]).toEqual(
      expect.objectContaining({ name: { firstName: "Jo", lastName: "" } }),
    );
    const done = (await db.query.chatRequests.findFirst({ where: eq(chatRequests.id, r.id) }))!;
    expect(done.crmStatus).toBe("sent");
  });

  it("a refused key fails at once with what to do; a busy Twenty is tried again, then noted", async () => {
    const { bot, lead } = await leadBot();
    const r = await sendForm(bot, lead, { name: "Al", company: "Al Co", email: "al@alco.test" });

    twenty.fail = { status: 401 };
    await sendLead(r.id);
    let row = (await db.query.chatRequests.findFirst({ where: eq(chatRequests.id, r.id) }))!;
    expect(row.crmStatus).toBe("failed");
    expect(row.crmNote).toMatch(/refused the API key/);

    // The team fixes it and sends it again; Twenty is busy: the job is tried again later.
    const admin = await makeUser("admin");
    await resendLead(admin, r.id);
    twenty.fail = { status: 503 };
    await expect(sendLead(r.id)).rejects.toThrow(/busy/);
    row = (await db.query.chatRequests.findFirst({ where: eq(chatRequests.id, r.id) }))!;
    expect(row.crmStatus).toBe("queued");
    await sendLead(r.id, { lastTry: true });
    row = (await db.query.chatRequests.findFirst({ where: eq(chatRequests.id, r.id) }))!;
    expect(row.crmStatus).toBe("failed");
    expect(row.crmNote).toMatch(/busy/);
  });

  it("waits while Twenty isn't connected, and the team can't send it until it is", async () => {
    delete process.env.TWENTY_API_KEY;
    const { bot, lead } = await leadBot();
    const r = await sendForm(bot, lead, { name: "Pat", email: "pat@patco.test" });
    expect(r.crmStatus).toBe("waiting");
    const admin = await makeUser("admin");
    await expect(resendLead(admin, r.id)).rejects.toThrow(/isn't connected/);
    process.env.TWENTY_API_KEY = "test-twenty-key";
    await resendLead(admin, r.id);
    await sendLead(r.id);
    expect(twenty.store.people).toHaveLength(1);
    // No company given, and a work address: the company is named after its web address.
    expect(twenty.store.companies[0]).toEqual(expect.objectContaining({ name: "patco.test" }));
  });
});
