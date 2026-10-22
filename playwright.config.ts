import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a production build (`next start`) with the
 * deterministic AI stand-ins and the in-memory sign-in stand-in. The
 * database in E2E_DATABASE_URL is wiped first: never point it at real data.
 */
const PORT = 3100;
const DB = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/billie_e2e";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec tsx tests/e2e/reset-db.ts && pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      E2E_DATABASE_URL: DB,
      DATABASE_URL: DB,
      DIRECT_DATABASE_URL: DB,
      NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
      BILLIE_LOCAL_AUTH: "1",
      NEON_AUTH_BASE_URL: "",
      AI_PROVIDER: "fake",
      EMBEDDINGS_PROVIDER: "fake",
      CRON_SECRET: "e2e-only-cron-secret-value",
      FIRST_ADMIN_EMAIL: "",
    },
  },
});
