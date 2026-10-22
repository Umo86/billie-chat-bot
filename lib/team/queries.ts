import "server-only";
import { and, asc, desc, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { invitations, users } from "@/lib/db/schema";

export async function teamMembers() {
  return db
    .select({
      id: users.id,
      name: users.fullName,
      email: users.email,
      role: users.role,
      status: users.status,
      linked: users.authUserId,
      lastSeenAt: users.lastSeenAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.fullName));
}

export async function openInvitations() {
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      name: invitations.fullName,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(
      and(
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitations.createdAt));
}
