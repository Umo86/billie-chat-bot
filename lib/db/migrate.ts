import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describeDatabase, migrationDatabaseUrl } from "./urls";

/**
 * `pnpm db:migrate` and the Vercel build (`vercel-build`): applies any
 * migrations the database hasn't had, over the direct connection. Safe to
 * run on every deploy; prints the host, never the credentials.
 */
export async function runMigrations(url: string, folder = "lib/db/migrations"): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 30 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: folder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const url = migrationDatabaseUrl();
  if (!url) {
    // A preview build without a database still builds; it just has nothing to migrate.
    console.warn("No database URL set: skipping migrations.");
    return;
  }
  console.log(`Migrating ${describeDatabase(url)}`);
  await runMigrations(url);
  console.log("Migrations up to date.");
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
