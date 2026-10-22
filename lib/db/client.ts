import { attachDatabasePool } from "@vercel/functions";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { appDatabaseUrl, normaliseSsl } from "./urls";

/**
 * Server-only Postgres client, following Neon's guidance for Vercel Fluid
 * compute: node-postgres over TCP with a connection pool, registered with
 * attachDatabasePool so idle connections close before the function is
 * suspended (it does nothing outside Vercel). The pool is made on first use,
 * so importing this module during `next build` without a database is harmless.
 */
type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let instance: { db: DrizzleDb; pool: Pool } | null = null;

function connect() {
  if (instance) return instance;
  const url = appDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({
    connectionString: normaliseSsl(url),
    max: 10,
    idleTimeoutMillis: 10_000,
    // A Neon compute that scaled to zero takes a moment to wake.
    connectionTimeoutMillis: 15_000,
  });
  // A dropped connection (compute restart, network) must not crash the process.
  pool.on("error", (err) => console.error("database pool error", err.message));
  attachDatabasePool(pool);
  instance = { db: drizzle({ client: pool, schema }), pool };
  return instance;
}

export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_target, prop) {
    const real = connect().db as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

export type Db = DrizzleDb;
export type Tx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];
/** Either the pool or an open transaction: helpers that take one work inside or outside a transaction. */
export type DbOrTx = Db | Tx;

/** Rows of a raw SQL statement (node-postgres returns them under .rows). */
export async function query<T extends Record<string, unknown>>(
  runner: DbOrTx,
  statement: SQL,
): Promise<T[]> {
  const result = await runner.execute<T>(statement);
  return result.rows as T[];
}

/** Close the pool (scripts and tests). */
export async function closeDb(): Promise<void> {
  if (!instance) return;
  await instance.pool.end();
  instance = null;
}
