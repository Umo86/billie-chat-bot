import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/** Liveness and database reachability, for uptime checks. Reveals nothing else. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json({ ok: true, database: "up" });
  } catch {
    return Response.json({ ok: false, database: "down" }, { status: 503 });
  }
}
