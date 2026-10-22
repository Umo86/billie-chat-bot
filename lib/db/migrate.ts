import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { describeDatabase, migrationDatabaseUrl, normaliseSsl } from "./urls";

/**
 * `pnpm db:migrate` and the Vercel build (`vercel-build`): applies any
 * migrations the database hasn't had, over the direct (unpooled)
 * connection, recording each in drizzle.__drizzle_migrations. Safe to run on
 * every deploy; prints the host, never the credentials.
 */
export async function runMigrations(url: string, folder = "lib/db/migrations"): Promise<void> {
  const client = new Client({
    connectionString: normaliseSsl(url),
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: folder });
  } finally {
    await client.end();
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
