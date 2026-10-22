import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";

export type Settings = typeof settings.$inferSelect;

/** The one settings row (created by migration 0002; recreated here if ever missing). */
export async function getSettings(): Promise<Settings> {
  const row = await db.query.settings.findFirst({ where: eq(settings.id, "main") });
  if (row) return row;
  const [created] = await db.insert(settings).values({ id: "main" }).onConflictDoNothing().returning();
  return created ?? (await db.query.settings.findFirst({ where: eq(settings.id, "main") }))!;
}
