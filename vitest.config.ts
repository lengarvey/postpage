import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(__dirname, "migrations"),
  );

  return {
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // Pin the domains: .dev.vars (local dev) must not leak into
              // tests. Empty PAGES_URL_BASE means "derive from PAGES_DOMAIN".
              PAGES_DOMAIN: "pages.postpage.ai",
              PAGES_URL_BASE: "",
              // API identity uses the dev stub; the browser login flow is
              // exercised against these fake WorkOS values (no network).
              AUTH_MODE: "dev-stub",
              AUTH_SECRET: "test-auth-secret-not-for-production",
              WORKOS_API_KEY: "sk_test_fake",
              WORKOS_CLIENT_ID: "client_test_fake",
            },
          },
        },
      },
    },
  };
});
