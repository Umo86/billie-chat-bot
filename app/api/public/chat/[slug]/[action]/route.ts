import { headers } from "next/headers";
import { z } from "zod";
import { appUrl } from "@/lib/config";
import { allow, clientKey, ipFrom, LIMITS } from "@/lib/rate-limit";
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
import { sameOrigin } from "@/lib/chat/domains";
import { botBySlug } from "@/lib/bots/load";
import {
  ChatError,
  cancelDetails,
  cleanContact,
  handover,
  rateMessage,
  requestOffered,
  startConversation,
  startTask,
  submitDetails,
  submitRequest,
  visitorMessage,
  visitorUpdates,
} from "@/lib/conversations/service";
import type { HandoverReason } from "@/lib/conversations/handover";
import { cleanAnswers, cleanOrder, orderAnswers, REQUEST_CONTACT } from "@/lib/requests/rules";
import { taskExhibitor, typesFor } from "@/lib/requests/tasks";
import {
  dropEmptyConversation,
  requestCode,
  SignInError,
  SignInLimit,
  signInOpen,
  signOut,
  verifyCode,
  type SignedIn,
} from "@/lib/exhibitors/sign-in";
import {
  manualSignInLine,
  manualSignInOpen,
  readManualSignIn,
  signInFromManual,
} from "@/lib/exhibitors/blueprint";

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
 *   POST request           { typeId, answers, contact } from a request form
 *   POST sign-in           { email } an exhibitor asks for a code to sign in
 *   POST verify            { code } the code from their email
 *   POST sign-in-token     { token } signed in from BluePrint, the exhibitor manual
 *   POST sign-out          stop using their record in this chat
 *
 * A chat belongs to whoever holds its token (Authorization: Bearer …). No
 * cookies, no visitor accounts. Every write is rate limited.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ slug: string; action: string }> };

function failure(err: unknown): Response {
  if (err instanceof SignInLimit) return problem(429, err.message);
  if (err instanceof SignInError) return problem(400, err.message);
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
  /** From the exhibitor manual, with the first message of a chat (see "sign-in-token"). */
  signInToken: z.string().max(2048).optional(),
});
const manualBody = z.object({ token: z.string().min(1).max(2048) });
const detailsBody = z.object({ contact: z.record(z.string(), z.unknown()) });
const requestBody = z.object({
  typeId: z.string().min(1).max(20),
  answers: z.record(z.string(), z.unknown()),
  contact: z.record(z.string(), z.unknown()),
  /** How many of each item, for a request with things to order. */
  items: z.record(z.string(), z.unknown()).optional(),
});
const taskBody = z.object({ typeId: z.string().min(1).max(20) });
const signInBody = z.object({ email: z.email().max(200) });
const badEmail = () =>
  problem(400, "That email address doesn't look right.", {
    fieldErrors: { email: "That email address doesn't look right." },
  });
const verifyBody = z.object({ code: z.string().min(6).max(12) });
const ratingBody = z.object({
  messageId: z.uuid(),
  rating: z.union([z.literal(1), z.literal(-1)]),
});

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { slug, action } = await ctx.params;
  if (
    ![
      "messages",
      "handover",
      "details",
      "cancel",
      "rating",
      "request",
      "task",
      "sign-in",
      "verify",
      "sign-in-token",
      "sign-out",
    ].includes(action)
  )
    return problem(404, "Not found.");
  // Only the chat's own pages write here: never a page on another website
  // making its visitors' browsers send for it (a form or text/plain needs no
  // permission from us; JSON from another site does).
  if (!sameOrigin(request)) return problem(403, "This chat only works from its own page.");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    return problem(415, "Send this as JSON.");
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
    const ip = clientKey(ipFrom(await headers()));
    let conversation = await callerConversation(request, bot);
    let token: string | undefined;
    const tooManyCodes = () =>
      problem(429, "You've asked for a lot of codes. Wait a few minutes, then try again.");
    // Signing in can be the first thing someone does: it starts the chat.
    // The limits come first, so a refused request never leaves an empty chat.
    let ipCounted = false;
    if (action === "sign-in" && !conversation && channel !== "whatsapp") {
      if (!(await signInOpen(bot))) return problem(404, "Signing in isn't available in this chat.");
      if (!signInBody.safeParse(body).success) return badEmail();
      if (!(await allow(`chat:start:${ip}`, LIMITS.chatStart)))
        return problem(429, "Too many new chats. Wait a few minutes, then try again.");
      if (!(await allow(`chat:sign-in:${ip}`, LIMITS.chatSignInIp))) return tooManyCodes();
      ipCounted = true;
      const started = await startConversation({ bot, channel });
      conversation = started.conversation;
      token = started.token ?? undefined;
    }

    // Signed in to BluePrint, the exhibitor manual: the chat opens signed in,
    // with no code. Nothing is kept until they ask something: with no chat
    // yet, the token comes again with the first message, which starts the
    // chat signed in. A chat signed in as someone else, or closed, is never
    // signed in as them: the chat starts a new one.
    if (action === "sign-in-token") {
      if (channel === "whatsapp" || !(await manualSignInOpen(bot)))
        return problem(404, "Signing in isn't available in this chat.");
      const parsed = manualBody.safeParse(body);
      if (!parsed.success)
        return problem(400, manualSignInLine("malformed"), { reason: "malformed" });
      if (!(await allow(`chat:manual:${ip}`, LIMITS.chatManualSignIn)))
        return problem(429, "Too many sign-ins from here. Wait a few minutes, then try again.");
      const who = await readManualSignIn(bot, parsed.data.token);
      if (!who.ok)
        return problem(who.reason === "not_listed" ? 403 : 401, manualSignInLine(who.reason), {
          reason: who.reason,
        });
      const signedIn: SignedIn = {
        name: who.exhibitor.name,
        company: who.exhibitor.company,
        stand: who.exhibitor.stand,
      };
      if (!conversation) return json({ pending: true, signedIn });
      if (!(await allow(`chat:conv:${conversation.id}`, LIMITS.chatPerConversation)))
        return problem(429, "Too many requests. Wait a few minutes, then try again.");
      const done =
        conversation.status === "closed" ? null : await signInFromManual(bot, conversation.id, who);
      if (!done || done.result === "other")
        return problem(409, "This chat can't be signed in as you. Start a new one.", {
          reason: "new_chat",
        });
      const fresh = await callerConversation(request, bot);
      return json(await visitorUpdates(bot, fresh ?? conversation, null));
    }

    if (action === "messages") {
      const parsed = messageBody.safeParse(body);
      if (!parsed.success) return problem(400, "Type a message first.");
      const allowed =
        (await allow(`chat:ip:${ip}:${bot.id}`, LIMITS.chatMessage)) &&
        (await allow(`chat:day:${ip}`, LIMITS.chatDaily)) &&
        (conversation
          ? await allow(`chat:conv:${conversation.id}`, LIMITS.chatPerConversation)
          : await allow(`chat:start:${ip}`, LIMITS.chatStart));
      if (!allowed)
        return problem(429, "You've sent a lot of messages. Wait a few minutes, then try again.");
      const pageUrl = cleanPageUrl(parsed.data.pageUrl);
      // The first message from someone signed in to the manual: the chat starts signed in,
      // so Billie's first answer can already use their record.
      let manual: { token?: string; signedIn: SignedIn | null; signInNote?: string } | null = null;
      if (
        !conversation &&
        parsed.data.signInToken &&
        channel !== "whatsapp" &&
        (await manualSignInOpen(bot))
      ) {
        const who = await readManualSignIn(bot, parsed.data.signInToken);
        if (who.ok) {
          const started = await startConversation({ bot, channel, pageUrl });
          conversation = started.conversation;
          const done = await signInFromManual(bot, conversation.id, who);
          manual = { token: started.token ?? undefined, signedIn: done.signedIn };
        } else manual = { signedIn: null, signInNote: manualSignInLine(who.reason) };
      }
      const turn = await visitorMessage({
        bot,
        conversation,
        channel,
        text: parsed.data.text,
        pageUrl,
      });
      return json(
        manual
          ? {
              ...turn,
              ...(manual.token ? { token: manual.token } : {}),
              signedIn: manual.signedIn,
              ...(manual.signInNote ? { signInNote: manual.signInNote } : {}),
            }
          : turn,
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
    if (action === "sign-out") {
      if (channel === "whatsapp" || !((await signInOpen(bot)) || (await manualSignInOpen(bot))))
        return problem(404, "Signing in isn't available in this chat.");
      if (conversation.status === "closed")
        return problem(409, "This chat has ended. Start a new one.");
      await signOut(conversation.id);
      return json(await visitorUpdates(bot, { ...conversation, exhibitorId: null }, null));
    }
    if (action === "sign-in" || action === "verify") {
      if (channel === "whatsapp" || !(await signInOpen(bot)))
        return problem(404, "Signing in isn't available in this chat.");
      if (conversation.status === "closed")
        return problem(409, "This chat has ended. Start a new one.");
      if (action === "sign-in") {
        const parsed = signInBody.safeParse(body);
        if (!parsed.success) return badEmail();
        if (
          !(await allow(`chat:sign-in:conv:${conversation.id}`, LIMITS.chatSignIn)) ||
          (!ipCounted && !(await allow(`chat:sign-in:${ip}`, LIMITS.chatSignInIp)))
        )
          return tooManyCodes();
        let message: string;
        try {
          message = await requestCode(bot, conversation.id, parsed.data.email);
        } catch (err) {
          // Don't leave behind an empty chat this request started.
          if (token) await dropEmptyConversation(conversation.id);
          throw err;
        }
        return json({ message, ...(token ? { token, conversationId: conversation.id } : {}) });
      }
      const parsed = verifyBody.safeParse(body);
      if (!parsed.success) return problem(400, "Type the six-digit code from the email.");
      if (!(await allow(`chat:verify:${conversation.id}`, LIMITS.chatVerify)))
        return problem(429, "Too many tries. Wait a few minutes, then ask for a new code.");
      await verifyCode(bot, conversation.id, parsed.data.code);
      const fresh = await callerConversation(request, bot);
      return json(await visitorUpdates(bot, fresh ?? conversation, null));
    }
    if (action === "task") {
      const parsed = taskBody.safeParse(body);
      if (!parsed.success || channel === "whatsapp") return problem(400, "Bad request.");
      return json(await startTask(bot, conversation.id, parsed.data.typeId));
    }
    if (action === "request") {
      const parsed = requestBody.safeParse(body);
      if (!parsed.success) return problem(400, "Check the form.");
      // Only this bot's own requests, only those for this chat's exhibitor (some are for some
      // stands only), and only one Billie offered in this chat (not WhatsApp).
      const exhibitor = channel === "whatsapp" ? null : await taskExhibitor(conversation);
      const type =
        channel === "whatsapp"
          ? null
          : typesFor(bot, exhibitor).find((t) => t.id === parsed.data.typeId);
      if (!type || !(await requestOffered(conversation.id, type.id)))
        return problem(404, "That request isn't available any more. Ask again.");
      const { answers, errors } = cleanAnswers(type, parsed.data.answers);
      const { contact, errors: contactErrors } = cleanContact(REQUEST_CONTACT, parsed.data.contact);
      // The order is worked out here, at the prices the team set: never the page's own sums.
      const { order, error: orderError } = cleanOrder(type, parsed.data.items ?? {});
      if (orderError) errors.items = orderError;
      if (Object.keys(errors).length || Object.keys(contactErrors).length)
        return problem(400, "Check the form.", { fieldErrors: { ...errors, ...contactErrors } });
      // Counted once the form is complete. Per chat, and generously per address: a whole
      // hall of exhibitors can share one venue Wi-Fi address.
      if (
        !(await allow(`chat:request:conv:${conversation.id}`, LIMITS.chatRequestConversation)) ||
        !(await allow(`chat:request:${ip}`, LIMITS.chatRequest))
      )
        return problem(429, "You've sent a lot of requests. Wait a while, or email the team.");
      return json(
        await submitRequest(
          bot,
          conversation.id,
          type,
          order ? [...answers, ...orderAnswers(order)] : answers,
          contact,
          { order, exhibitorId: exhibitor?.id ?? null },
        ),
      );
    }
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
