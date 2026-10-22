import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bots } from "@/lib/db/schema";
import { frameAncestors } from "./domains";

/**
 * frame-ancestors for a bot's chat frame, read by proxy.ts: a live bot may be
 * shown by its allowed websites (and their subdomains); anything else only
 * inside the app itself (the Try page).
 */
export async function frameAncestorsFor(slug: string): Promise<string> {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.slug, slug), isNull(bots.deletedAt)),
    columns: { status: true, domains: true },
  });
  return bot ? frameAncestors(bot.domains, bot.status === "live") : "'self'";
}
