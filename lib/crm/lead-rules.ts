/**
 * Leads for Twenty CRM, the pure parts (tests/unit/crm-pure.test.ts): someone
 * on a visitor chat wants to exhibit, fills in the "Interested in exhibiting"
 * form, and the sales team gets them in Twenty as a person at their company
 * with an opportunity for the show and a note of what they said.
 */
import type { ContactDetails, RequestAnswer } from "@/lib/types";

type Env = Record<string, string | undefined>;

/** Twenty's address (its cloud by default, or the team's own), without a trailing slash. */
export function twentyBase(env: Env = process.env): string {
  const url = env.TWENTY_API_URL?.trim() || "https://api.twenty.com";
  return url.replace(/\/+$/, "").replace(/\/rest$/, "");
}

/** Twenty's host, for showing which Twenty is connected (never throws on a mistyped address). */
export function twentyHost(env: Env = process.env): string {
  const base = twentyBase(env);
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

export function twentyConfigured(env: Env = process.env): boolean {
  return Boolean(env.TWENTY_API_KEY?.trim());
}

/** Where the team opens a record in Twenty, when its app address is set (TWENTY_APP_URL). */
export function twentyRecordUrl(
  kind: "opportunity" | "person",
  id: string,
  env: Env = process.env,
): string | null {
  const app = env.TWENTY_APP_URL?.trim().replace(/\/+$/, "");
  return app ? `${app}/object/${kind}/${encodeURIComponent(id)}` : null;
}

/** "Sam de la Cruz" → first "Sam", last "de la Cruz". */
export function splitName(full: string | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  return { firstName: parts[0].slice(0, 100), lastName: parts.slice(1).join(" ").slice(0, 100) };
}

/** Email services anyone can sign up to: their domain says nothing about the company. */
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "aol.com",
  "btinternet.com",
  "sky.com",
  "virginmedia.com",
  "talktalk.net",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "mail.com",
]);

/** The company's web address from a work email ("sam@acme.co.uk" → "https://acme.co.uk"). */
export function companyDomain(email: string | undefined): string | null {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec((email ?? "").trim());
  if (!m) return null;
  const host = m[1].toLowerCase();
  return FREE_MAIL.has(host) ? null : `https://${host}`;
}

/**
 * A phone number for Twenty: UK numbers in their parts ("+44", "7700 900123");
 * anything else as typed, with no country.
 */
export function phoneParts(raw: string | undefined): {
  primaryPhoneNumber: string;
  primaryPhoneCountryCode: string;
  primaryPhoneCallingCode: string;
} | null {
  const typed = (raw ?? "").trim();
  const digits = typed.replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length < 7) return null;
  if (/^(\+44|0044)/.test(digits))
    return {
      primaryPhoneNumber: digits.replace(/^(\+44|0044)0?/, ""),
      primaryPhoneCountryCode: "GB",
      primaryPhoneCallingCode: "+44",
    };
  if (/^0\d{9,10}$/.test(digits))
    return {
      primaryPhoneNumber: digits.slice(1),
      primaryPhoneCountryCode: "GB",
      primaryPhoneCallingCode: "+44",
    };
  // Elsewhere: as typed. If Twenty won't take it, the lead goes without (it's in the note).
  return { primaryPhoneNumber: digits, primaryPhoneCountryCode: "", primaryPhoneCallingCode: "" };
}

/** A value inside Twenty's REST filter: in double quotes, with none inside it. */
export function filterValue(v: string): string {
  return `"${v.replace(/["\\]/g, "").trim()}"`;
}

export type Lead = {
  contact: ContactDetails;
  answers: RequestAnswer[];
  show: string;
  botName: string;
  /** "R-1042": the request's reference in Billie. */
  ref: string;
  /** The page they were on when they asked, if any. */
  page: string | null;
  /** The chat in Billie's Inbox, for the sales team. */
  chatUrl: string;
};

/** The opportunity's name in Twenty: "Acme Ltd – exhibiting at UKCW London 2027". */
export function opportunityName(lead: Lead): string {
  const who = lead.contact.company?.trim() || lead.contact.name?.trim() || "New exhibitor";
  return `${who} – exhibiting at ${lead.show || "the show"}`.slice(0, 200);
}

const md = (s: string) => s.replace(/([\\`*_[\]#>|])/g, "\\$1").replace(/\n/g, "  \n");

/** The note on the lead in Twenty: what they said, and where it came from. */
export function leadNote(lead: Lead): { title: string; markdown: string } {
  const c = lead.contact;
  const rows = [
    ["Name", c.name],
    ["Company", c.company],
    ["Email", c.email],
    ["Phone", c.phone],
  ].filter(([, v]) => v?.trim());
  return {
    title: `Exhibiting enquiry from the ${lead.botName} chat (${lead.ref})`.slice(0, 200),
    markdown: [
      `**${md(lead.show || "The show")}**: an enquiry about exhibiting, sent through the ${md(lead.botName)} chat.`,
      "",
      ...rows.map(([k, v]) => `- **${k}**: ${md(v!.trim())}`),
      ...lead.answers.map((a) => `- **${md(a.label)}**: ${md(a.value)}`),
      "",
      lead.page ? `They were on ${md(lead.page)}.` : "",
      `The chat in Billie: ${lead.chatUrl}`,
    ]
      .filter((l, i, a) => l !== "" || a[i - 1] !== "")
      .join("\n")
      .trim(),
  };
}
