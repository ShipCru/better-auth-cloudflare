-- D1 fallback schema for the better-auth-cloudflare DO adapter.
-- Apply once: `wrangler d1 execute ba-cf-do-fallback --remote --file ./fallback-schema.sql`
-- (Or --local for the Miniflare D1 instance during dev.)
--
-- Schema matches FALLBACK_D1_SCHEMA exported from the package; kept here
-- as a stable file the user can version-control alongside their app.

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  name                TEXT,
  email               TEXT UNIQUE,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  image               TEXT,
  is_anonymous        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  provider_id         TEXT NOT NULL,
  account_id          TEXT,
  -- password hash deliberately NOT mirrored; stays in the DO only
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (provider_id, account_id)
);

CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts(user_id);
