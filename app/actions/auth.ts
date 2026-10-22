"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/server";
import { allow, ipFrom, LIMITS } from "@/lib/rate-limit";
import { AccountError, acceptInvitation, createFirstAdmin, hasAnyUser } from "@/lib/team/accounts";
import { fail, type ActionResult } from "@/lib/actions/result";

/**
 * Sign-in, first-run set-up and invitations. Each signs in on the server
 * (Better Auth sets the cookie) and limits attempts per email and per IP.
 */
async function signInOnServer(email: string, password: string): Promise<boolean> {
  try {
    await getAuth().api.signInEmail({ body: { email, password }, headers: await headers() });
    return true;
  } catch {
    return false;
  }
}

export async function signIn(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return fail("Enter your email and password.");
  const ip = ipFrom(await headers());
  const ok =
    (await allow(`signin:email:${email}`, LIMITS.signIn)) &&
    (await allow(`signin:ip:${ip}`, LIMITS.signInIp));
  if (!ok) return fail("Too many attempts. Wait 15 minutes, then try again.");
  if (!(await signInOnServer(email, password)))
    return fail("That email and password don't match an active account.");
  redirect("/");
}

export async function signOut(): Promise<void> {
  try {
    await getAuth().api.signOut({ headers: await headers() });
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
  if (!(await allow(`setup:ip:${ip}`, LIMITS.invite)))
    return fail("Too many attempts. Wait a few minutes.");
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  try {
    await createFirstAdmin({ name: String(form.get("name") ?? ""), email, password });
  } catch (err) {
    if (err instanceof AccountError) return fail(err.message);
    console.error("set-up failed", err);
    return fail("Set-up didn't finish. Try again.");
  }
  await signInOnServer(email.trim().toLowerCase(), password);
  redirect("/?welcome=1");
}

export async function acceptInvite(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return fail("The two passwords don't match.");
  const ip = ipFrom(await headers());
  if (!(await allow(`invite:ip:${ip}`, LIMITS.invite)))
    return fail("Too many attempts. Wait a few minutes.");
  let email: string;
  try {
    ({ email } = await acceptInvitation(token, password));
  } catch (err) {
    if (err instanceof AccountError) return fail(err.message);
    console.error("invitation failed", err);
    return fail("That didn't work. Try again.");
  }
  await signInOnServer(email, password);
  redirect("/");
}
