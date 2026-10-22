import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { appDatabaseUrl, isNeon } from "./urls";

/**
 * Server-only Postgres client (postgres.js + Drizzle), made on first use so
 * importing this module during `next build` without a database is harmless.
 *
 * On Neon the pooled URL goes through PgBouncer in transaction mode:
 * prepared statements off, a handful of connections per function instance,
 * idle connections released quickly, and time for a cold endpoint to wake.
 */
type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let instance: { db: DrizzleDb; sql: postgres.Sql } | null = null;

function connect() {
  if (instance) return instance;
  const url = appDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = isNeon(url)
    ? postgres(url, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 15 })
    : postgres(url, { prepare: false, max: 10, onnotice: () => {} });
  instance = { db: drizzle(sql, { schema }), sql };
  return instance;
}

export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_target, prop) {
    const real = connect().db as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

/** Close the pool (scripts and tests). */
export async function closeDb(): Promise<void> {
  if (!instance) return;
  await instance.sql.end({ timeout: 5 });
  instance = null;
}

export type Db = DrizzleDb;
export type Tx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];
/** Either the pool or an open transaction: helpers that take one work inside or outside a transaction. */
export type DbOrTx = Db | Tx;
