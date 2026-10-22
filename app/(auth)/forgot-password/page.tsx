import type { Metadata } from "next";
import { ForgotForm } from "@/components/auth/auth-card";
import { requestPasswordReset } from "@/app/actions/auth";

export const metadata: Metadata = { title: "Forgot your password" };
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return <ForgotForm action={requestPasswordReset} />;
}
