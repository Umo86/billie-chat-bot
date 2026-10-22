import { headers } from "next/headers";
import { z } from "zod";
import { appUrl } from "@/lib/config";
import { allow, ipFrom, LIMITS } from "@/lib/rate-limit";
import {
  callerConversation,
  chatBot,
  cleanPageUrl,
  json,
  originAllowed,
  problem,
  publicBot,
  SLUG,
} from "@/lib/chat/public";
import { botBySlug } from "@/lib/bots/load";
import {
  ChatError,
  cancelDetails,
  cleanContact,
  handover,
  rateMessage,
  submitDetails,
  visitorMessage,
  visitorUpdates,
} from "@/lib/conversations/service";
import type { HandoverReason } from "@/lib/conversations/handover";

/**
 * The public chat API, used by the chat frame (/embed/…) and the chat page
 * (/c/…), both on this app's own address:
 *
 *   GET  config            the bot's name, look and welcome (CORS for widget.js)
 *   GET  messages?after=   new messages (polled while a person has the chat)
 *   POST messages          { text, pageUrl?, channel? } → Billie's reply
 *   POST handover          pass the chat to the team
 *   POST details           { contact } when nobody is online
 *   POST cancel            close the details form
 *   POST rating            { messageId, rating: 1 | -1 }
 *
 * A chat belongs to whoever holds its token (Authorization: Bearer …). No
 * cookies, no visitor accounts. Every write is rate limited.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ slug: string; action: string }> };

function failure(err: unknown): Response {
  if (err instanceof ChatError) {
    const status = { not_found: 404, invalid: 400, closed: 409, not_allowed: 403 }[err.code];
    return problem(status, err.message);
  }
  console.error("public chat failed", err);
  return problem(500, "Something went wrong. Try again in a moment.");
}

export async function OPTIONS(request: Request, ctx: Ctx): Promise<Response> {
  const { slug, action } = await ctx.params;
  if (action !== "config") return new Response(null, { status: 404 });
  const bot = SLUG.test(slug) ? await botBySlug(slug) : null;
  const origin = request.headers.get("origin");
  if (!bot || bot.status !== "live" || !originAllowed(origin, bot, new URL(appUrl()).origin))
    return new Response(null, { status: 404 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin!,
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const { slug, action } = await ctx.params;
  const url = new URL(request.url);
  try {
    if (action === "config") {
      // Called by widget.js from the bot's websites: only live bots, only allowed sites.
      const bot = SLUG.test(slug) ? await botBySlug(slug) : null;
      const origin = request.headers.get("origin");
      const self = new URL(appUrl()).origin;
      if (!bot || bot.status !== "live") return problem(404, "This chat isn't available.");
      if (origin && !originAllowed(origin, bot, self))
        return problem(404, "This chat isn't available on this website.");
      return json(await publicBot(bot), 200, {
        ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
        Vary: "Origin",
      });
    }
    if (action !== "messages") return problem(404, "Not found.");
    const found = await chatBot(slug, url.searchParams.get("channel"));
    if (found instanceof Response) return found;
    const conversation = await callerConversation(request, found.bot);
    if (!conversation) return problem(404, "This chat has ended. Start a new one.");
    const afterRaw = url.searchParams.get("after");
    const after = afterRaw && !Number.isNaN(Date.parse(afterRaw)) ? new Date(afterRaw) : null;
    return json(await visitorUpdates(found.bot, conversation, after));
  } catch (err) {
    return failure(err);
  }
}

const messageBody = z.object({
  text: z.string().max(4000),
  pageUrl: z.string().max(1000).optional(),
  channel: z.enum(["web", "hosted", "try"]).optional(),
});
const detailsBody = z.object({ contact: z.record(z.string(), z.unknown()) });
const ratingBody = z.object({
  messageId: z.uuid(),
  rating: z.union([z.literal(1), z.literal(-1)]),
});

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { slug, action } = await ctx.params;
  if (!["messages", "handover", "details", "cancel", "rating"].includes(action))
    return problem(404, "Not found.");
  let body: unknown = {};
  try {
    const raw = await request.text();
    if (raw.length > 20_000) return problem(413, "That's too long.");
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return problem(400, "Bad request.");
  }
  const asked =
    (body as { channel?: string }).channel ?? new URL(request.url).searchParams.get("channel");

  try {
    const found = await chatBot(slug, asked ?? null);
    if (found instanceof Response) return found;
    const { bot, channel } = found;
    const ip = ipFrom(await headers());
    const conversation = await callerConversation(request, bot);

    if (action === "messages") {
      const parsed = messageBody.safeParse(body);
      if (!parsed.success) return problem(400, "Type a message first.");
      const allowed =
        (await allow(`chat:ip:${ip}:${bot.id}`, LIMITS.chatMessage)) &&
        (conversation
          ? await allow(`chat:conv:${conversation.id}`, LIMITS.chatPerConversation)
          : await allow(`chat:start:${ip}`, LIMITS.chatStart));
      if (!allowed)
        return problem(429, "You've sent a lot of messages. Wait a few minutes, then try again.");
      return json(
        await visitorMessage({
          bot,
          conversation,
          channel,
          text: parsed.data.text,
          pageUrl: cleanPageUrl(parsed.data.pageUrl),
        }),
      );
    }

    if (!conversation) return problem(404, "This chat has ended. Start a new one.");
    if (!(await allow(`chat:conv:${conversation.id}`, LIMITS.chatPerConversation)))
      return problem(429, "Too many requests. Wait a few minutes, then try again.");

    if (action === "handover") {
      const reason: HandoverReason = "asked_for_person";
      return json(await handover(bot, conversation.id, reason));
    }
    if (action === "cancel") return json(await cancelDetails(conversation.id));
    if (action === "details") {
      const parsed = detailsBody.safeParse(body);
      if (!parsed.success) return problem(400, "Check your details.");
      const { contact, errors } = cleanContact(bot.rules.collect, parsed.data.contact);
      if (Object.keys(errors).length)
        return problem(400, "Check your details.", { fieldErrors: errors });
      return json(await submitDetails(bot, conversation.id, contact));
    }
    const parsed = ratingBody.safeParse(body);
    if (!parsed.success) return problem(400, "Bad request.");
    return json(await rateMessage(conversation.id, parsed.data.messageId, parsed.data.rating));
  } catch (err) {
    return failure(err);
  }
}
