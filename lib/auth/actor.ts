import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { can, type Action, type Actor } from "@/lib/authz";
import { getAuth } from "./server";

/**
 * Who is signed in (cached per request). A database hiccup reads as signed
 * out and is logged, never a crash page.
 */
export const getActor = cache(async (): Promise<Actor | null> => {
  try {
    const session = await getAuth().api.getSession({ headers: await headers() });
    if (!session) return null;
    const u = await db.query.users.findFirst({ where: eq(users.id, session.user.id) });
    if (!u || u.status !== "active") return null;
    return { id: u.id, email: u.email, name: u.fullName, role: u.role, status: u.status };
  } catch (err) {
    console.error("session check failed", err instanceof Error ? err.message : err);
    return null;
  }
});

/** For pages: sends signed-out people to sign in, and people whose role isn't enough to Home (with a note). */
export async function requireActor(action?: Action): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (action && !can(actor, action)) redirect("/?denied=1");
  return actor;
}
