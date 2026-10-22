/**
 * Before any test file runs: give the test database a clean schema and apply
 * every migration once, so DB-backed tests start from what production has.
 * Never point TEST_DATABASE_URL at real data: it is wiped.
 */
import "dotenv/config";
import { Client } from "pg";
import { runMigrations } from "../lib/db/migrate";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS public CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      CREATE SCHEMA public;`);
  } finally {
    await client.end();
  }
  await runMigrations(url);
}
