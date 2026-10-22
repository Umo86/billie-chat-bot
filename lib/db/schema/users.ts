import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  bigint,
} from "drizzle-orm/pg-core";
import { role, userStatus } from "./enums";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/**
 * Staff accounts in Billie. Who someone is (email and password) lives in
 * Neon Auth (the neon_auth schema, managed by Neon); this row is what they
 * may do in Billie. auth_user_id links the two; linked_at is when the link
 * was made, and sessions older than that are refused (lib/auth/actor.ts).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authUserId: text("auth_user_id"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    email: text("email").notNull(),
    fullName: text("full_name").notNull(),
    role: role("role").notNull().default("agent"),
    status: userStatus("status").notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    uniqueIndex("users_auth_user_id_unique").on(t.authUserId),
  ],
);

/** Invitations to the team: a link with a one-time token (stored as its SHA-256). */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    fullName: text("full_name").notNull(),
    role: role("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invitations_token_hash_unique").on(t.tokenHash),
    index("invitations_email_idx").on(t.email),
    index("invitations_invited_by_idx").on(t.invitedBy),
  ],
);

/**
 * Who is answering live chats. "Available" lasts until available_until (8
 * hours from the switch, extended while the Inbox is open).
 */
export const agentPresence = pgTable("agent_presence", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  availableUntil: timestamp("available_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Fixed-window rate limits (lib/rate-limit.ts), for sign-in and the public
 * chat. key = HMAC of the bucket, so no IPs or emails are stored in clear.
 */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: bigint("window_start", { mode: "number" }).notNull(),
});
