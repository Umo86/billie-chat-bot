import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { invitations, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { hashToken, newToken } from "@/lib/chat/token";
import { appUrl, emailConfigured } from "@/lib/config";
import { sendEmail } from "@/lib/email/send";
import { EMAIL_PATTERN, INVITE_DAYS, firstAdminAllowed, normaliseEmail } from "@/lib/auth/config";
import type { AuthUser } from "@/lib/auth/provider";
import type { Actor, Role } from "@/lib/authz";

/**
 * The team: the first admin, invitations, roles and suspensions. Passwords
 * are never here: Neon Auth keeps them. A Billie account is linked to a
 * Neon Auth user only by the first-run set-up or by an invitation link, so
 * signing up with Neon Auth alone never gets anyone into Billie.
 */
export class AccountError extends Error {}

export async function hasAnyUser(): Promise<boolean> {
  const row = await db.query.users.findFirst({ columns: { id: true } });
  return Boolean(row);
}

export function checkFirstAdmin(input: { name: string; email: string }): void {
  if (!input.name.trim()) throw new AccountError("Add your name.");
  if (!EMAIL_PATTERN.test(normaliseEmail(input.email)))
    throw new AccountError("That email doesn't look right.");
  if (!firstAdminAllowed(input.email))
    throw new AccountError(
      "Only the address set as FIRST_ADMIN_EMAIL can create the first account.",
    );
}

/** First run only: links the first signed-up person as an admin. Serialised so two can't race. */
export async function linkFirstAdmin(
  authUser: AuthUser,
  name: string,
  startedAt: Date,
): Promise<string> {
  checkFirstAdmin({ name, email: authUser.email });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(424242)`);
    const any = await tx.query.users.findFirst({ columns: { id: true } });
    if (any) throw new AccountError("Billie is already set up. Sign in instead.");
    const [u] = await tx
      .insert(users)
      .values({
        authUserId: authUser.id,
        linkedAt: startedAt,
        email: normaliseEmail(authUser.email),
        fullName: name.trim(),
        role: "admin",
      })
      .returning();
    await writeAudit(tx, {
      actorUserId: u.id,
      entityType: "user",
      entityId: u.id,
      action: "create",
      summary: "Created the first admin account",
    });
    return u.id;
  });
}

export function inviteLink(token: string): string {
  return `${appUrl()}/invite/${token}`;
}

/** An invitation, or for someone already on the team, a fresh link to sign in with. */
export async function createInvitation(
  actor: Actor,
  input: { email: string; name: string; role: Role },
): Promise<{ link: string; emailed: boolean }> {
  const email = normaliseEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) throw new AccountError("That email doesn't look right.");
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  const name = input.name.trim() || existing?.fullName || email.split("@")[0];
  const token = newToken();
  await db.transaction(async (tx) => {
    // Older open links for the same address stop working.
    await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
    await tx.insert(invitations).values({
      email,
      fullName: name,
      role: existing?.role ?? input.role,
      tokenHash: hashToken(token),
      invitedBy: actor.id,
      expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
    });
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "invitation",
      action: "invite",
      summary: existing
        ? `Made a new sign-in link for ${name}`
        : `Invited ${name} as ${input.role}`,
    });
  });
  const link = inviteLink(token);
  let emailed = false;
  if (emailConfigured()) {
    try {
      await sendEmail({
        to: email,
        subject: existing
          ? "Your link to sign in to Billie"
          : `${actor.name} invited you to Billie`,
        text: `Hi ${name.split(" ")[0]},\n\n${
          existing
            ? "Use this link to sign in to Billie again:"
            : `${actor.name} invited you to Billie, the Media10 chat and email assistant. Use this link to choose your password and sign in:`
        }\n\n${link}\n\nThe link works once and expires in ${INVITE_DAYS} days.`,
      });
      emailed = true;
    } catch (err) {
      console.warn("invite email not sent", err instanceof Error ? err.message : err);
    }
  }
  return { link, emailed };
}

export async function invitationForToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  const row = await db.query.invitations.findFirst({
    where: and(
      eq(invitations.tokenHash, hashToken(token)),
      isNull(invitations.acceptedAt),
      isNull(invitations.revokedAt),
      gt(invitations.expiresAt, new Date()),
    ),
  });
  return row ?? null;
}

/**
 * Uses the link up and links the signed-in Neon Auth user to Billie: a new
 * team member with the invited role, or (for someone already on the team)
 * the same account, now signed in through this Neon Auth user.
 */
export async function acceptInvitation(
  token: string,
  authUser: AuthUser,
  startedAt: Date,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(invitations.tokenHash, hashToken(token)),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!inv)
      throw new AccountError(
        "This link has expired or was already used. Ask an admin for a new one.",
      );
    if (normaliseEmail(authUser.email) !== inv.email)
      throw new AccountError("This link is for a different email address.");
    // Whoever this Neon Auth user was linked to before stops being them.
    await tx
      .update(users)
      .set({ authUserId: null, linkedAt: null })
      .where(and(eq(users.authUserId, authUser.id), sql`${users.email} <> ${inv.email}`));
    const existing = await tx.query.users.findFirst({ where: eq(users.email, inv.email) });
    let id: string;
    if (existing) {
      if (existing.status !== "active")
        throw new AccountError("This account is suspended. Ask an admin to reactivate it.");
      await tx
        .update(users)
        .set({ authUserId: authUser.id, linkedAt: startedAt })
        .where(eq(users.id, existing.id));
      id = existing.id;
    } else {
      const [u] = await tx
        .insert(users)
        .values({
          authUserId: authUser.id,
          linkedAt: startedAt,
          email: inv.email,
          fullName: inv.fullName,
          role: inv.role,
        })
        .returning({ id: users.id });
      id = u.id;
    }
    await writeAudit(tx, {
      actorUserId: id,
      entityType: "user",
      entityId: id,
      action: existing ? "update" : "create",
      summary: existing ? "Signed in again from a new link" : `Joined the team as ${inv.role}`,
    });
    return id;
  });
}

export async function changeRole(actor: Actor, userId: string, role: Role): Promise<void> {
  if (userId === actor.id) throw new AccountError("You can't change your own role.");
  await db.transaction(async (tx) => {
    const [u] = await tx.update(users).set({ role }).where(eq(users.id, userId)).returning();
    if (!u) throw new AccountError("That person isn't on the team.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "user",
      entityId: u.id,
      action: "role_change",
      summary: `Made ${u.fullName} ${role}`,
    });
  });
}

/** Suspended people are refused on their very next request (lib/auth/actor.ts). */
export async function setSuspended(
  actor: Actor,
  userId: string,
  suspended: boolean,
): Promise<void> {
  if (userId === actor.id) throw new AccountError("You can't suspend yourself.");
  await db.transaction(async (tx) => {
    const [u] = await tx
      .update(users)
      .set({ status: suspended ? "suspended" : "active" })
      .where(eq(users.id, userId))
      .returning();
    if (!u) throw new AccountError("That person isn't on the team.");
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "user",
      entityId: u.id,
      action: "status_change",
      summary: `${suspended ? "Suspended" : "Reactivated"} ${u.fullName}`,
    });
  });
}

/** For the Neon Auth sign-up check: may this email create an account? */
export async function signUpAllowed(email: string): Promise<boolean> {
  const e = normaliseEmail(email);
  const invited = await db.query.invitations.findFirst({
    where: and(
      eq(invitations.email, e),
      isNull(invitations.acceptedAt),
      isNull(invitations.revokedAt),
      gt(invitations.expiresAt, new Date()),
    ),
    columns: { id: true },
  });
  if (invited) return true;
  return !(await hasAnyUser()) && firstAdminAllowed(e);
}
