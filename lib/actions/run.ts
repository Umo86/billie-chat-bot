import "server-only";
import { z } from "zod";
import { getActor } from "@/lib/auth/actor";
import { can, type Action, type Actor } from "@/lib/authz";
import { AiError } from "@/lib/ai/provider";
import { ChatError } from "@/lib/conversations/service";
import { KnowledgeError } from "@/lib/knowledge/sources";
import { AccountError } from "@/lib/team/accounts";
import { UnsafeUrlError } from "@/lib/knowledge/web";
import { UserError } from "@/lib/errors";
import { fail, success, type ActionResult } from "./result";

export { UserError };

/**
 * Every staff server action runs through here: who is signed in, may they do
 * this (lib/authz.ts), is the input valid (zod), then the work. Known
 * problems come back as plain sentences; anything else is logged and the
 * person sees a generic line, never a stack trace.
 */

export function friendly(err: unknown): string | null {
  if (err instanceof UserError || err instanceof ChatError || err instanceof KnowledgeError)
    return err.message;
  if (err instanceof AccountError || err instanceof UnsafeUrlError) return err.message;
  if (err instanceof AiError) {
    if (err.code === "not_configured") return "Claude isn't connected yet (ANTHROPIC_API_KEY).";
    if (err.code === "cap_reached")
      return "Today's answer limit has been reached. Raise it in Settings.";
    return "Claude couldn't answer just now. Try again in a moment.";
  }
  return null;
}

export async function runAction<S extends z.ZodType, T>(
  action: Action,
  schema: S,
  input: unknown,
  work: (actor: Actor, data: z.infer<S>) => Promise<T>,
  message?: string,
): Promise<ActionResult<T>> {
  const actor = await getActor();
  if (!actor) return fail("Your session has ended. Sign in again.");
  if (!can(actor, action)) return fail("You don't have access to do that.");
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return fail("Check the highlighted fields.", fieldErrors);
  }
  try {
    return success(await work(actor, parsed.data), message);
  } catch (err) {
    const text = friendly(err);
    if (text) return fail(text);
    console.error(`action ${action} failed`, err);
    return fail("Something went wrong. Try again, and tell an admin if it keeps happening.");
  }
}
