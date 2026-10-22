/**
 * Every test file: the app's database client talks to the test database,
 * and Claude and embeddings use the deterministic stand-ins.
 */
import "dotenv/config";

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AI_PROVIDER = "fake";
process.env.EMBEDDINGS_PROVIDER = "fake";
