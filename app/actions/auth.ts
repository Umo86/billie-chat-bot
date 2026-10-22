"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { appUrl } from "@/lib/config";
import { authProvider, type AuthResult, type AuthUser } from "@/lib/auth/provider";
import {
  firstAdminAllowed,
  normaliseEmail,
  passwordProblem,
  sessionAllowed,
  setupCodeValid,
} from "@/lib/auth/config";
import { allow, ipFrom, LIMITS } from "@/lib/rate-limit";
import {
  AccountError,
  acceptInvitation,
  checkFirstAdmin,
  hasAnyUser,
  invitationForToken,
  linkFirstAdmin,
  openInvitationFor,
} from "@/lib/team/accounts";
import { fail, failWith, success, type ActionResult } from "@/lib/actions/result";

/**
 * Sign-in, first-run set-up, invitations and password resets. Each one runs
 * on the server against Neon Auth (which sets the session cookie), limits
 * attempts per email and per IP, and then checks Billie's own team list:
 * a Neon Auth account alone never gets anyone in.
 */
async function limited(...keys: [string, (typeof LIMITS)[keyof typeof LIMITS]][]) {
  for (const [key, rule] of keys) if (!(await allow(key, rule))) return true;
  return false;
}

/** Signs up, or if that email already has a sign-in, signs in with the same password. */
async function signUpOrIn(
  email: string,
  password: string,
  name: string,
): Promise<AuthResult<AuthUser>> {
  const auth = await authProvider();
  const created = await auth.signUp({ email, password, name });
  if (created.ok || created.code !== "user_exists") return created;
  const signedIn = await auth.signIn(email, password);
  if (signedIn.ok || signedIn.code !== "invalid_credentials") return signedIn;
  return {
    ok: false,
    code: "invalid_credentials",
    message: `There's already a sign-in for ${email}. Enter that password, or reset it from the sign-in page.`,
  };
}

export async function signIn(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const email = normaliseEmail(String(form.get("email") ?? ""));
  const password = String(form.get("password") ?? "");
  const no = (message: string) => failWith(message, { email });
  if (!email || !password) return no("Enter your email and password.");
  const ip = ipFrom(await headers());
  if (await limited([`signin:email:${email}`, LIMITS.signIn], [`signin:ip:${ip}`, LIMITS.signInIp]))
    return no("Too many attempts. Wait 15 minutes, then try again.");

  const auth = await authProvider();
  const result = await auth.signIn(email, password);
  if (!result.ok)
    return no(
      result.code === "invalid_credentials"
        ? "That email and password don't match an account."
        : result.message,
    );
  const member = await db.query.users.findFirst({ where: eq(users.authUserId, result.data.id) });
  if (!member || member.status !== "active" || !sessionAllowed(member.linkedAt, new Date())) {
    await auth.signOut();
    return no(
      member?.status === "suspended"
        ? "Your access to Billie has been suspended. Ask an admin if this is a mistake."
        : "This account isn't on the Billie team. Ask an admin to invite you.",
    );
  }
  redirect("/");
}

export async function signOut(): Promise<void> {
  try {
    await (await authProvider()).signOut();
  } catch {
    // Already signed out.
  }
  redirect("/login");
}

export async function setUpFirstAdmin(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  if (await hasAnyUser()) redirect("/login");
  const ip = ipFrom(await headers());
  if (await limited([`setup:ip:${ip}`, LIMITS.invite]))
    return fail("Too many attempts. Wait a few minutes.");
  const name = String(form.get("name") ?? "").trim();
  const email = normaliseEmail(String(form.get("email") ?? ""));
  const password = String(form.get("password") ?? "");
  const no = (message: string) => failWith(message, { name, email });
  if (!setupCodeValid(String(form.get("code") ?? "")))
    return no("That set-up code isn't right. It's the CRON_SECRET value added in Vercel.");
  try {
    checkFirstAdmin({ name, email });
  } catch (err) {
    return no(err instanceof AccountError ? err.message : "Check your details.");
  }
  const problem = passwordProblem(password);
  if (problem) return no(problem);

  const startedAt = new Date();
  const signedIn = await signUpOrIn(email, password, name);
  if (!signedIn.ok) return no(signedIn.message);
  try {
    await linkFirstAdmin(signedIn.data, name, startedAt);
  } catch (err) {
    await (await authProvider()).signOut();
    if (err instanceof AccountError) return no(err.message);
    console.error("set-up failed", err);
    return no("Set-up didn't finish. Try again.");
  }
  redirect("/?welcome=1");
}

export async function acceptInvite(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const token = String(form.get("token") ?? "");
  const name = String(form.get("name") ?? "").trim();
  const no = (message: string) => failWith(message, { name });
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return no("The two passwords don't match.");
  const problem = passwordProblem(password);
  if (problem) return no(problem);
  const ip = ipFrom(await headers());
  if (await limited([`invite:ip:${ip}`, LIMITS.invite]))
    return no("Too many attempts. Wait a few minutes.");

  const invitation = await invitationForToken(token);
  if (!invitation)
    return no("This link has expired or was already used. Ask an admin for a new one.");
  const startedAt = new Date();
  const signedIn = await signUpOrIn(invitation.email, password, name || invitation.fullName);
  if (!signedIn.ok) return no(signedIn.message);
  try {
    await acceptInvitation(token, signedIn.data, startedAt);
  } catch (err) {
    await (await authProvider()).signOut();
    if (err instanceof AccountError) return no(err.message);
    console.error("invitation failed", err);
    return no("That didn't work. Try again.");
  }
  redirect("/");
}

/** Members, people with an open invitation, and on a fresh site the first admin. */
async function resetAllowed(email: string): Promise<boolean> {
  const member = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (member) return member.status === "active";
  if (await openInvitationFor(email)) return true;
  return !(await hasAnyUser()) && firstAdminAllowed(email);
}

export async function requestPasswordReset(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const email = normaliseEmail(String(form.get("email") ?? ""));
  const no = (message: string) => failWith(message, { email });
  if (!email) return no("Enter your email.");
  const ip = ipFrom(await headers());
  if (await limited([`reset:email:${email}`, LIMITS.invite], [`reset:ip:${ip}`, LIMITS.invite]))
    return no("Too many attempts. Wait a few minutes.");
  // Only people on the team (or invited to it, or setting it up) get an
  // email; everyone sees the same answer.
  if (await resetAllowed(email)) {
    const result = await (
      await authProvider()
    ).requestPasswordReset(email, `${appUrl()}/reset-password`);
    if (!result.ok && result.code === "unavailable") return no(result.message);
    if (!result.ok) console.warn("password reset not sent", result.code);
  }
  return success(
    undefined,
    "If that email is on the Billie team, a link to choose a new password is on its way. It works for 15 minutes.",
  );
}

export async function resetPassword(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return fail("The two passwords don't match.");
  const problem = passwordProblem(password);
  if (problem) return fail(problem);
  if (!/^[\w.~-]{8,512}$/.test(token)) return fail("This link has expired. Ask for a new one.");
  const ip = ipFrom(await headers());
  if (await limited([`reset:ip:${ip}`, LIMITS.invite]))
    return fail("Too many attempts. Wait a few minutes.");
  const result = await (await authProvider()).resetPassword(token, password);
  if (!result.ok) return fail(result.message);
  redirect("/login?reset=1");
}
