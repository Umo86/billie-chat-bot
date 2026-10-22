/**
 * Which connection string to use. Pure functions of the environment (tested
 * in tests/unit/db-urls.test.ts); never logs or returns credentials anywhere
 * but to the database client.
 *
 * Neon's Vercel integration sets DATABASE_URL (pooled, "-pooler" host) and
 * DATABASE_URL_UNPOOLED (direct). The app runs on the pooled one; migrations
 * need a session, so they use the direct one.
 */
type Env = Record<string, string | undefined>;

export function appDatabaseUrl(env: Env = process.env): string | null {
  return env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim() || null;
}

export function migrationDatabaseUrl(env: Env = process.env): string | null {
  return (
    env.DIRECT_DATABASE_URL?.trim() ||
    env.DATABASE_URL_UNPOOLED?.trim() ||
    env.POSTGRES_URL_NON_POOLING?.trim() ||
    appDatabaseUrl(env)
  );
}

/** Neon (or any pooled host) needs prepared statements off and few connections per instance. */
export function isNeon(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

/** The host and database name only, for logs and /api/health. */
export function describeDatabase(url: string | null): string {
  if (!url) return "not set";
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "invalid URL";
  }
}
