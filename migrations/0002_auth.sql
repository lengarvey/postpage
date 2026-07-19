-- Migration number: 0002

-- WorkOS user cache: maps a WorkOS user id to its (verified) email so API
-- requests never need a WorkOS round-trip after first sight. Rows are
-- refreshed on every browser login and inserted on first API use.
CREATE TABLE users (
  workos_user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_users_email ON users (email);

-- One-time login handoff codes minted by the trusted apex /auth/callback and
-- redeemed exactly once by the destination page host's /auth/session.
CREATE TABLE login_codes (
  code TEXT PRIMARY KEY,
  workos_user_id TEXT NOT NULL,
  -- Verified email at mint time, or NULL when the user has none.
  email TEXT,
  -- Exact page hostname this code may establish a session for.
  host TEXT NOT NULL,
  -- Exact /s/{uuid} path to land on after the session is set.
  redirect_path TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Host-only page sessions. The cookie stores only the random id; identity
-- lives here. A session for one page hostname is useless on any other.
CREATE TABLE page_sessions (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  workos_user_id TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_page_sessions_expires ON page_sessions (expires_at);
