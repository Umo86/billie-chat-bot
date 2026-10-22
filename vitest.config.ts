import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: { "server-only": new URL("./tests/mocks/empty.ts", import.meta.url).pathname },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    // DB-backed tests use TEST_DATABASE_URL and skip themselves when it isn't set.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: { AI_PROVIDER: "fake", EMBEDDINGS_PROVIDER: "fake" },
  },
});
