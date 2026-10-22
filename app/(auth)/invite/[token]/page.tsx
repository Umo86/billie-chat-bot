import type { Metadata } from "next";
import { InviteForm, LinkProblem } from "@/components/auth/auth-card";
import { acceptInvite } from "@/app/actions/auth";
import { invitationForToken } from "@/lib/team/accounts";

export const metadata: Metadata = { title: "Set your password" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = /^[A-Za-z0-9_-]{20,200}$/.test(token) ? await invitationForToken(token) : null;
  if (!invitation) {
    return (
      <LinkProblem message="It has expired or was already used. Ask an admin to send you a new one." />
    );
  }
  return (
    <InviteForm
      action={acceptInvite}
      token={token}
      name={invitation.fullName}
      email={invitation.email}
    />
  );
}
