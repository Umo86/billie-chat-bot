import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/auth-card";
import { signIn } from "@/app/actions/auth";
import { getActor } from "@/lib/auth/actor";
import { hasAnyUser } from "@/lib/team/accounts";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!(await hasAnyUser())) redirect("/setup");
  if (await getActor()) redirect("/");
  return <SignInForm action={signIn} />;
}
