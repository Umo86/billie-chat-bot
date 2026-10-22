import type { Metadata } from "next";
import { LinkProblem, ResetForm } from "@/components/auth/auth-card";
import { resetPassword } from "@/app/actions/auth";

export const metadata: Metadata = { title: "Choose a new password" };
export const dynamic = "force-dynamic";

/** Neon Auth's reset email links here with ?token=… (or ?error=… when the link has expired). */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { token, error } = await searchParams;
  if (!token || error || !/^[\w.~-]{8,512}$/.test(token))
    return (
      <LinkProblem message="This link has expired. Ask for a new one from the sign-in page." />
    );
  return <ResetForm action={resetPassword} token={token} />;
}
