import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db, type Tx } from "@/lib/db/client";
import { authAccount, authSession, invitations, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { hashToken, newToken } from "@/lib/chat/token";
import { appUrl, emailConfigured } from "@/lib/config";
import { sendEmail } from "@/lib/email/send";
import { INVITE_DAYS, firstAdminAllowed, passwordProblem } from "@/lib/auth/config";
import type { Actor, Role } from "@/lib/authz";

/**
 * Accounts: the first admin, invitations, roles, suspensions. Passwords
 * are hashed with Better Auth's scrypt and stored on a "credential" account
 * row, exactly as Better Auth's own sign-in expects.
 */
export class AccountError extends Error {}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function setPassword(tx: Tx, userId: string, password: string) {
  const hash = await hashPassword(password);
  const existing = await tx.query.authAccount.findFirst({
    where: and(eq(authAccount.userId, userId), eq(authAccount.providerId, "credential")),
  });
  if (existing) {
    await tx
      .update(authAccount)
      .set({ password: hash, updatedAt: new Date() })
      .where(eq(authAccount.id, existing.id));
  } else {
    await tx
      .insert(authAccount)
      .values({ userId, accountId: userId, providerId: "credential", password: hash });
  }
  // A new password signs every other session out.
  await tx.delete(authSession).where(eq(authSession.userId, userId));
}

export async function hasAnyUser(): Promise<boolean> {
  const row = await db.query.users.findFirst({ columns: { id: true } });
  return Boolean(row);
}

/** First run only: the first account is an admin. Serialised so two can't race. */
export async function createFirstAdmin(input: {
  name: string;
  email: string;
  password: string;
}): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!name) throw new AccountError("Add your name.");
  if (!EMAIL.test(email)) throw new AccountError("That email doesn't look right.");
  const problem = passwordProblem(input.password);
  if (problem) throw new AccountError(problem);
  if (!firstAdminAllowed(email)) {
    throw new AccountError(
      "Only the address set as FIRST_ADMIN_EMAIL can create the first account.",
    );
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(424242)`);
    const any = await tx.query.users.findFirst({ columns: { id: true } });
    if (any) throw new AccountError("Billie is already set up. Sign in instead.");
    const [u] = await tx.insert(users).values({ email, fullName: name, role: "admin" }).returning();
    await setPassword(tx, u.id, input.password);
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

/** An invitation (or, for someone already on the team, a link to set a new password). */
export async function createInvitation(
  actor: Actor,
  input: { email: string; name: string; role: Role },
): Promise<{ link: string; emailed: boolean }> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new AccountError("That email doesn't look right.");
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
        subject: existing ? "Set a new Billie password" : `${actor.name} invited you to Billie`,
        text: `Hi ${name.split(" ")[0]},\n\n${existing ? "Use this link to set a new password for Billie:" : `${actor.name} invited you to Billie, the Media10 chat and email assistant. Use this link to set your password and sign in:`}\n\n${link}\n\nThe link works once and expires in ${INVITE_DAYS} days.`,
      });
      emailed = true;
    } catch (err) {
      console.warn("invite email not sent", err instanceof Error ? err.message : err);
    }
  }
  return { link, emailed };
}

export async function invitationForToken(token: string) {
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

/** Accepting sets the password (creating the account if new) and uses the link up. */
export async function acceptInvitation(
  token: string,
  password: string,
): Promise<{ email: string }> {
  const problem = passwordProblem(password);
  if (problem) throw new AccountError(problem);
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
    let user = await tx.query.users.findFirst({ where: eq(users.email, inv.email) });
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({ email: inv.email, fullName: inv.fullName, role: inv.role })
        .returning();
    } else if (user.status !== "active") {
      throw new AccountError("This account is suspended. Ask an admin to reactivate it.");
    }
    await setPassword(tx, user.id, password);
    await writeAudit(tx, {
      actorUserId: user.id,
      entityType: "user",
      entityId: user.id,
      action: "update",
      summary: "Set a password from an invitation link",
    });
    return { email: user.email };
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
    if (suspended) await tx.delete(authSession).where(eq(authSession.userId, u.id));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "user",
      entityId: u.id,
      action: "status_change",
      summary: `${suspended ? "Suspended" : "Reactivated"} ${u.fullName}`,
    });
  });
}
