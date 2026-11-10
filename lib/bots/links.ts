/**
 * Links the bot can share (pure): the team's own addresses, each with when to
 * offer it, shown as buttons under an answer (Rules step). Visitors get
 * "Register to visit"; exhibitors get their badges (Visit Connect), their
 * website listing (ASP.events) and ordering. Claude picks which fits; it never
 * writes an address itself, so a link can't be made up or out of date.
 */
import type { BotLink } from "@/lib/types";

export const MAX_LINKS = 8;
export const LINK_LABEL_MAX = 40;
export const LINK_WHEN_MAX = 200;

/** A web address people can open: http(s) only, no spaces, no passwords in it. */
export function linkProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return "Add the address, starting https://";
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return "That isn't a web address. Copy it from the browser's address bar.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return "Use a web address starting https://";
  if (parsed.username || parsed.password) return "Leave any password out of the address.";
  if (u.length > 500) return "That address is too long.";
  return null;
}

export function newLinkId(): string {
  return `l${Math.random().toString(36).slice(2, 9)}`;
}

/** Tidied for saving: trimmed, empty ones left out, each id once, at most eight. */
export function cleanLinks(links: BotLink[]): BotLink[] {
  const seen = new Set<string>();
  const out: BotLink[] = [];
  for (const l of links) {
    const label = l.label.replace(/\s+/g, " ").trim().slice(0, LINK_LABEL_MAX);
    const url = l.url.trim();
    if (!label || !url) continue;
    let id = /^[a-z0-9]{2,12}$/i.test(l.id) ? l.id : newLinkId();
    while (seen.has(id)) id = newLinkId();
    seen.add(id);
    out.push({ id, label, url, when: l.when.replace(/\s+/g, " ").trim().slice(0, LINK_WHEN_MAX) });
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

export type LinkSuggestion = { label: string; when: string; hint: string };

/** Ready-made links for each kind of bot: the team adds the address. */
export const LINK_SUGGESTIONS: Record<"visitors" | "exhibitors", LinkSuggestion[]> = {
  visitors: [
    {
      label: "Register to visit",
      when: "They want to come to the show, ask about tickets, registering, prices or getting in, or sound keen to visit.",
      hint: "The show's registration page.",
    },
    {
      label: "See the agenda",
      when: "They ask what's on, or about talks, speakers, sessions or times.",
      hint: "The agenda or programme page.",
    },
    {
      label: "Exhibit at the show",
      when: "They want to read more about exhibiting or sponsoring.",
      hint: "The page about exhibiting. The exhibiting form takes their details.",
    },
  ],
  exhibitors: [
    {
      label: "Get your badges",
      when: "They ask about badges, passes, staff or contractor entry, or registering their team.",
      hint: "Visit Connect, where exhibitors get their badges.",
    },
    {
      label: "Update your website listing",
      when: "They ask about their company profile, listing, logo, description or products on the show's website.",
      hint: "Their profile on the show's website (ASP.events).",
    },
    {
      label: "Order stand services",
      when: "They want to order furniture, carpet, electrics, AV, cleaning or other services for their stand.",
      hint: "The ordering page of the exhibitor manual.",
    },
    {
      label: "Open the exhibitor manual",
      when: "They need the full rules, forms or deadlines.",
      hint: "The exhibitor manual's home page.",
    },
  ],
};
