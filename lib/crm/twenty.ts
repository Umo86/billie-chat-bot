import "server-only";
import {
  companyDomain,
  filterValue,
  leadNote,
  opportunityName,
  phoneParts,
  splitName,
  twentyBase,
  type Lead,
} from "./lead-rules";
import type { CrmIds } from "@/lib/db/schema/requests";

/**
 * Twenty CRM over its REST API (https://docs.twenty.com/developers/extend/api):
 * Bearer key, /rest/{objects}, filters like emails.primaryEmail[eq]:"x".
 * A lead becomes its company (found by web address or name, or made), its
 * person (found by email, or made), an opportunity for the show, and a note
 * of what they said. The key is read here, server-side only, never logged.
 */

export class TwentyError extends Error {
  constructor(
    message: string,
    /** Worth trying again later (busy, down, rate limited). */
    readonly retry: boolean,
    readonly status = 0,
  ) {
    super(message);
    this.name = "TwentyError";
  }
}

type Json = Record<string, unknown>;

async function call(method: "GET" | "POST" | "PATCH", path: string, body?: Json): Promise<Json> {
  const key = process.env.TWENTY_API_KEY?.trim();
  if (!key) throw new TwentyError("Twenty isn't connected: its API key isn't set.", false);
  let res: Response;
  try {
    res = await fetch(`${twentyBase()}/rest/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    throw new TwentyError("Twenty didn't answer. Billie will try again shortly.", true);
  }
  const json = (await res.json().catch(() => ({}))) as Json;
  if (res.ok) return json;
  if (res.status === 401 || res.status === 403)
    throw new TwentyError(
      "Twenty refused the API key. Check TWENTY_API_KEY, and that the key's role can create people, companies, opportunities and notes.",
      false,
      res.status,
    );
  if (res.status === 429 || res.status >= 500)
    throw new TwentyError("Twenty is busy. Billie will try again shortly.", true, res.status);
  const said =
    typeof json.message === "string"
      ? json.message
      : Array.isArray(json.messages)
        ? String(json.messages[0])
        : "";
  throw new TwentyError(
    `Twenty didn't accept it${said ? `: ${said.slice(0, 200)}` : ""}.`,
    false,
    res.status,
  );
}

/** The first record of a filtered list, or null. */
async function findOne(plural: string, filter: string): Promise<Json | null> {
  const json = await call("GET", `${plural}?filter=${encodeURIComponent(filter)}&limit=1`);
  const data = json.data as Record<string, unknown> | undefined;
  const list = data?.[plural];
  return Array.isArray(list) && list[0] && typeof list[0] === "object" ? (list[0] as Json) : null;
}

/** The new record from a create: { data: { createPerson: { id … } } }. */
function created(json: Json, singular: string): string {
  const data = json.data as Record<string, unknown> | undefined;
  const key = `create${singular[0].toUpperCase()}${singular.slice(1)}`;
  const rec = data?.[key] as Json | undefined;
  if (!rec || typeof rec.id !== "string")
    throw new TwentyError("Twenty's reply didn't say what it made.", false);
  return rec.id;
}

/** Checks the key and address work: lists one opportunity. */
export async function checkTwenty(): Promise<void> {
  await call("GET", "opportunities?limit=1");
}

async function company(lead: Lead): Promise<string | null> {
  const name = lead.contact.company?.trim();
  const domain = companyDomain(lead.contact.email);
  if (!name && !domain) return null;
  if (domain) {
    const host = domain.replace(/^https:\/\//, "");
    const hit = await findOne(
      "companies",
      `domainName.primaryLinkUrl[ilike]:${filterValue(`%${host}%`)}`,
    );
    if (hit) return String(hit.id);
  }
  if (name) {
    const hit = await findOne("companies", `name[ilike]:${filterValue(name)}`);
    if (hit) return String(hit.id);
  }
  return created(
    await call("POST", "companies", {
      name: name || domain!.replace(/^https:\/\//, ""),
      ...(domain ? { domainName: { primaryLinkUrl: domain } } : {}),
    }),
    "company",
  );
}

async function person(lead: Lead, companyId: string | null): Promise<string> {
  const email = lead.contact.email?.trim().toLowerCase();
  if (!email) throw new TwentyError("The lead has no email address.", false);
  const hit = await findOne("people", `emails.primaryEmail[eq]:${filterValue(email)}`);
  if (hit) {
    // Known already: tie them to the company if they had none.
    if (companyId && !hit.companyId)
      await call("PATCH", `people/${encodeURIComponent(String(hit.id))}`, { companyId });
    return String(hit.id);
  }
  const base: Json = {
    name: splitName(lead.contact.name),
    emails: { primaryEmail: email },
    ...(companyId ? { companyId } : {}),
  };
  const phones = phoneParts(lead.contact.phone);
  try {
    return created(await call("POST", "people", phones ? { ...base, phones } : base), "person");
  } catch (err) {
    // A number Twenty won't take mustn't lose the lead: it's in the note anyway.
    if (phones && err instanceof TwentyError && err.status === 400)
      return created(await call("POST", "people", base), "person");
    throw err;
  }
}

/** A note on the lead's records; older Twenty versions name the links without "target". */
async function note(lead: Lead, ids: CrmIds): Promise<void> {
  const { title, markdown } = leadNote(lead);
  const noteId = created(await call("POST", "notes", { title, bodyV2: { markdown } }), "note");
  const targets: [string, string | null][] = [
    ["Person", ids.personId],
    ["Company", ids.companyId],
    ["Opportunity", ids.opportunityId],
  ];
  for (const [kind, id] of targets) {
    if (!id) continue;
    try {
      await call("POST", "noteTargets", { noteId, [`target${kind}Id`]: id });
    } catch (err) {
      if (!(err instanceof TwentyError && err.status === 400)) throw err;
      await call("POST", "noteTargets", { noteId, [`${kind.toLowerCase()}Id`]: id });
    }
  }
}

/**
 * Sends a lead to Twenty. Safe to run again after a failure part way: the
 * company and person are found the second time, and `done` skips what was made.
 */
export async function pushLead(lead: Lead, done: Partial<CrmIds> = {}): Promise<CrmIds> {
  const companyId = done.companyId !== undefined ? done.companyId : await company(lead);
  const personId = done.personId ?? (await person(lead, companyId));
  const stage = process.env.TWENTY_LEAD_STAGE?.trim();
  const opportunityId =
    done.opportunityId ??
    created(
      await call("POST", "opportunities", {
        name: opportunityName(lead),
        pointOfContactId: personId,
        ...(companyId ? { companyId } : {}),
        ...(stage ? { stage } : {}),
      }),
      "opportunity",
    );
  const ids = { personId, companyId, opportunityId };
  // The note helps the sales team but isn't the lead: a failure here doesn't undo it.
  await note(lead, ids).catch((err) =>
    console.warn("twenty note not added", err instanceof Error ? err.message : err),
  );
  return ids;
}
