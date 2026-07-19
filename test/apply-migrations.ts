import { applyD1Migrations, env } from "cloudflare:test";

// Applied once per test run before any test file executes.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
