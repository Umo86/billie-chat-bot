/** Gives the end-to-end database a clean schema and every migration. */
import { Client } from "pg";
import { runMigrations } from "../../lib/db/migrate";

async function main() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is not set");
  const admin = new Client({ connectionString: url.replace(/\/[^/?]+(\?|$)/, "/postgres$1") });
  await admin.connect();
  const name = new URL(url).pathname.slice(1);
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
  await admin.end();
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS public CASCADE;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    CREATE SCHEMA public;`);
  await client.end();
  await runMigrations(url);
  console.log("e2e database ready");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
