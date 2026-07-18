-- Migration number: 0001

CREATE TABLE pages (
  uuid TEXT PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
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

-- Deleted pages keep uuid + hostname forever so hostnames are never reused.
CREATE TABLE tombstones (
  uuid TEXT PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
