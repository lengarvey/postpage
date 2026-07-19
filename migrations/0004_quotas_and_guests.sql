-- Migration number: 0004

-- Free-tier quotas/expiry and anonymous publishing
-- (ARCHITECTURE.md "Plans, quotas, and expiry", decided 2026-07-19).

-- Plan membership. Launching a paid tier is a value change, not a migration.
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';

-- Day (YYYY-MM-DD, UTC) of the last authorized content read; drives
-- activity-based free-tier expiry. Backfilled to the creation day; code
-- always sets it explicitly on insert, so the '' default never survives.
ALTER TABLE pages ADD COLUMN last_visited_at TEXT NOT NULL DEFAULT '';
UPDATE pages SET last_visited_at = substr(created_at, 1, 10);

CREATE INDEX idx_pages_last_visited ON pages (last_visited_at);

-- Publish-quota counters: one row per (key, UTC day), where key is
-- 'user:{workos_user_id}' for signed-in creators and 'ip:{client ip}' for
-- anonymous/guest creators. Incremented atomically with page creation;
-- deletes never refund.
CREATE TABLE usage_counters (
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);

-- Guest accounts minted by unauthenticated POST /v1/pages. The bearer token
-- is returned exactly once and stored only as a SHA-256 hash; there is no
-- recovery. Guests are swept once all their pages have expired.
CREATE TABLE guests (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Browser lock for guest-owned pages: the first browser to view a page binds
-- it to that browser's viewer cookie, irrevocably. One row per page; the
-- same viewer id serves for all of a browser's guest pages.
CREATE TABLE page_viewers (
  page_uuid TEXT PRIMARY KEY REFERENCES pages (uuid) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL,
  bound_at TEXT NOT NULL
);

-- Two-phase deletion, phase 1: pages whose D1 rows are gone but whose R2
-- objects may still exist. The daily cron (and a best-effort waitUntil on
-- DELETE) purges the R2 prefix and removes the row; both are idempotent.
CREATE TABLE r2_purge_queue (
  page_uuid TEXT PRIMARY KEY,
  enqueued_at TEXT NOT NULL
);
