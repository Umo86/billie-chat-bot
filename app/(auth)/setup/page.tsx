import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetUpForm } from "@/components/auth/auth-card";
import { setUpFirstAdmin } from "@/app/actions/auth";
import { hasAnyUser } from "@/lib/team/accounts";

export const metadata: Metadata = { title: "Set up" };
export const dynamic = "force-dynamic";

export default async function SetUpPage() {
  if (await hasAnyUser()) redirect("/login");
  return (
    <SetUpForm
      action={setUpFirstAdmin}
      lockedEmail={process.env.FIRST_ADMIN_EMAIL?.trim() || null}
    />
  );
}
