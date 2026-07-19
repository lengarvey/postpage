-- Migration number: 0003

-- Flat URLs (ARCHITECTURE.md "Page identity and URLs", revised 2026-07-19):
-- pages are served at https://{PAGES_DOMAIN}/{uuid}, so per-page hostnames
-- and the one-time-code session handoff go away. Browser sessions become one
-- host-only cookie on the serving origin, so sessions no longer carry a host.
-- There is no production data worth preserving, and SQLite cannot drop a
-- UNIQUE column with ALTER TABLE, so tables are dropped and recreated.

DROP TABLE login_codes;
DROP TABLE page_sessions;
DROP TABLE page_permissions;
DROP TABLE revisions;
DROP TABLE pages;
DROP TABLE tombstones;

CREATE TABLE pages (
  uuid TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  -- Currently served revision. NULL only transiently while the first upload
  -- is in flight; a page is never returned to clients in that state.
  current_revision INTEGER,
  -- Next revision number to reserve. Reservations may leave gaps.
  next_revision INTEGER NOT NULL DEFAULT 1,
  sharing_mode TEXT NOT NULL DEFAULT 'private'
    CHECK (sharing_mode IN ('private', 'public', 'specific_users')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_pages_owner_updated ON pages (owner_id, updated_at DESC, uuid);

CREATE TABLE revisions (
  page_uuid TEXT NOT NULL REFERENCES pages (uuid) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (page_uuid, revision)
);

CREATE TABLE page_permissions (
  page_uuid TEXT NOT NULL REFERENCES pages (uuid) ON DELETE CASCADE,
  email TEXT NOT NULL,
  PRIMARY KEY (page_uuid, email)
);

CREATE INDEX idx_page_permissions_email ON page_permissions (email);

-- Deleted pages keep their uuid forever so a page URL is never reused.
CREATE TABLE tombstones (
  uuid TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);

-- Browser sessions for the single serving origin. The cookie stores only the
-- random id; identity lives here.
CREATE TABLE page_sessions (
  id TEXT PRIMARY KEY,
  workos_user_id TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_page_sessions_expires ON page_sessions (expires_at);
