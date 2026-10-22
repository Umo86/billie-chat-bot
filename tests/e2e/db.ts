import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";

/** Direct database access for end-to-end set-up steps (never used by the app). */
export async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({
    connectionString:
      process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/billie_e2e",
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** An invitation as an admin would make it; returns the link's token. */
export async function invite(email: string, name: string, role: "admin" | "editor" | "agent") {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await withDb((c) =>
    c.query(
      `INSERT INTO invitations (email, full_name, role, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
      [email, name, role, hash],
    ),
  );
  return token;
}
