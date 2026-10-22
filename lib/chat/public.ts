import "server-only";
import { getActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { botBySlug, type BotRow } from "@/lib/bots/load";
import { getSettings } from "@/lib/settings";
import { bearer } from "./token";
import { normaliseDomain } from "./domains";
import {
  conversationForToken,
  type Channel,
  type ConversationRow,
} from "@/lib/conversations/service";
import type { ContactField } from "@/lib/types";

/**
 * Shared by the public chat routes: which bot, may this caller use it, and
 * which chat is theirs. Visitors are anonymous; their chat is theirs because
 * they hold its token. Draft bots answer only signed-in staff (the Try page).
 */
export type PublicBot = {
  slug: string;
  name: string;
  showName: string;
  audience: "visitors" | "exhibitors";
  color: string;
  avatarUrl: string | null;
  welcome: string;
  starters: string[];
  consent: string;
  collect: ContactField[];
  promise: string;
  live: boolean;
};

export async function publicBot(bot: BotRow): Promise<PublicBot> {
  const s = await getSettings();
  return {
    slug: bot.slug,
    name: bot.name,
    showName: bot.showName,
    audience: bot.audience,
    color: bot.color,
    avatarUrl: bot.avatarUrl,
    welcome: bot.welcome,
    starters: bot.starters,
    consent: s.consentText,
    collect: bot.rules.collect,
    promise: bot.rules.promise,
    live: bot.status === "live",
  };
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

export function problem(status: number, error: string, extra: Record<string, unknown> = {}) {
  return json({ error, ...extra }, status);
}

/**
 * The bot for a chat request, and the channel it really is. A draft bot is
 * only for staff trying it ("try"); "try" is never trusted from a visitor.
 */
export async function chatBot(
  slug: string,
  asked: string | null,
): Promise<{ bot: BotRow; channel: Channel } | Response> {
  if (!SLUG.test(slug)) return problem(404, "This chat isn't available.");
  const bot = await botBySlug(slug);
  if (!bot) return problem(404, "This chat isn't available.");
  const staff = asked === "try" || bot.status !== "live" ? await getActor() : null;
  if (bot.status !== "live" || asked === "try") {
    if (!staff || !can(staff, "bots.view")) return problem(404, "This chat isn't available.");
    return { bot, channel: "try" };
  }
  return { bot, channel: asked === "hosted" ? "hosted" : "web" };
}

/** The caller's chat (Authorization: Bearer <token>), or null when they have none. */
export async function callerConversation(
  request: Request,
  bot: BotRow,
): Promise<ConversationRow | null> {
  const token = bearer(request.headers.get("authorization"));
  return token ? conversationForToken(token, bot.id) : null;
}

/** True when a page on `origin` may show this bot (its allowed websites, or the app itself). */
export function originAllowed(origin: string | null, bot: BotRow, appOrigin: string): boolean {
  if (!origin) return false;
  if (origin === appOrigin) return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return bot.domains.some((d) => {
    const allowed = normaliseDomain(d);
    if (!allowed) return false;
    const h = host.replace(/^www\./, "");
    return h === allowed || h.endsWith(`.${allowed}`);
  });
}

/** The page the visitor was on (for the Inbox), without its query string; null if not a web address. */
export function cleanPageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 1000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // Keep the page, not its query string or fragment (they can hold private tokens).
    return `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}
