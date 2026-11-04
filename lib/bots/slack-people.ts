import "server-only";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { botMembers, bots, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { EVERY_BOT_ROLES, type Actor } from "@/lib/authz";
import { slackConfigured, slackUserIdFor } from "@/lib/channels/slack";

/**
 * Each show's bot has its own Slack people (People step): Billie
 * @mentions them on its chats that need a person, its tickets, email
 * replies to check and requests, in the bot's Slack channel, instead of
 * @here. They're Billie users on that bot, found in Slack by their email.
 */

/** Someone works on this bot: an admin, or one of its people. */
const worksOn = (botId: string) =>
  or(
    inArray(users.role, [...EVERY_BOT_ROLES]),
    sql`EXISTS (SELECT 1 FROM ${botMembers} m WHERE m.user_id = ${users.id} AND m.bot_id = ${botId})`,
  )!;

/** The emails of the bot's Slack people who can still sign in and work on it. */
export async function slackPeopleFor(botId: string): Promise<string[]> {
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    columns: { slackPeople: true },
  });
  if (!bot?.slackPeople.length) return [];
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(inArray(users.id, bot.slackPeople), eq(users.status, "active"), worksOn(botId)));
  return rows.map((r) => r.email);
}

/** Chooses the bot's Slack people: only people who work on it. */
export async function setSlackPeople(
  actor: Actor,
  botId: string,
  userIds: string[],
): Promise<void> {
  const wanted = [...new Set(userIds)];
  await db.transaction(async (tx) => {
    const [bot] = await tx
      .select({ name: bots.name, before: bots.slackPeople })
      .from(bots)
      .where(and(eq(bots.id, botId), isNull(bots.deletedAt)))
      .for("update");
    if (!bot) throw new UserError("That bot no longer exists.");
    const valid = wanted.length
      ? (
          await tx
            .select({ id: users.id })
            .from(users)
            .where(and(inArray(users.id, wanted), worksOn(botId)))
        ).map((r) => r.id)
      : [];
    if (valid.length !== wanted.length)
      throw new UserError(
        "Only people who work on this bot can be told about it in Slack. Add them above first.",
      );
    await tx.update(bots).set({ slackPeople: valid }).where(eq(bots.id, botId));
    await writeAudit(tx, {
      actorUserId: actor.id,
      entityType: "bot",
      entityId: botId,
      action: "update",
      summary: `Chose who's told in Slack about "${bot.name}": ${valid.length} ${valid.length === 1 ? "person" : "people"}`,
      before: { slackPeople: bot.before },
      after: { slackPeople: valid },
    });
  });
}

export type SlackMatch = "found" | "missing" | "unknown";

/**
 * Whether each person is in Slack under their Billie email (so Billie can
 * @mention them, and match their replies): "unknown" when Slack couldn't be asked.
 */
export async function slackMatches(emails: string[]): Promise<Record<string, SlackMatch>> {
  const out: Record<string, SlackMatch> = {};
  if (!slackConfigured()) return out;
  await Promise.all(
    emails.map(async (email) => {
      try {
        out[email] = (await slackUserIdFor(email)) ? "found" : "missing";
      } catch {
        out[email] = "unknown";
      }
    }),
  );
  return out;
}
