import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

// The Worker plugin isolates files; explicitly reset storage between tests.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch([
    "page_viewers", "page_permissions", "revisions", "pages", "page_sessions",
    "tombstones", "usage_counters", "guests", "users", "r2_purge_queue",
  ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));

  let cursor: string | undefined;
  do {
    const objects = await env.PAGES_BUCKET.list({ cursor });
    if (objects.objects.length) {
      await env.PAGES_BUCKET.delete(objects.objects.map((object) => object.key));
    }
    cursor = objects.truncated ? objects.cursor : undefined;
  } while (cursor);
});
