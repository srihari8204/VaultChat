-- VaultChat Phase 1 schema: auth foundation
-- Idempotent — safe to re-run. Run with:
--   psql "$DATABASE_URL" -f migrations/001_init.sql
-- or:
--   psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f migrations/001_init.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";    -- case-insensitive email

-- ── users ───────────────────────────────────────────────────────────
-- Email is canonical identity. Phone is optional profile field.
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             CITEXT NOT NULL UNIQUE,
  email_verified_at TIMESTAMPTZ,

  name              TEXT,
  phone             TEXT,
  phone_hash        TEXT,
  photo_url         TEXT,
  dob               DATE,

  google_sub        TEXT UNIQUE,

  pin_hash          TEXT,
  face_count        INTEGER NOT NULL DEFAULT 0,

  security_q1       TEXT,
  security_a1_hash  TEXT,
  security_q2       TEXT,
  security_a2_hash  TEXT,

  status            TEXT,
  online            BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at      TIMESTAMPTZ,

  auth_provider     TEXT,
  is_deleted        BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at        TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON users(phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

-- ── otp_codes ───────────────────────────────────────────────────────
-- OTPs are short-lived and rate-limited via Redis; this table persists
-- the bcrypt hash + expiry so we don't lose them on Redis restart.
CREATE TABLE IF NOT EXISTS otp_codes (
  id          BIGSERIAL PRIMARY KEY,
  email       CITEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_email_unconsumed
  ON otp_codes(email, expires_at)
  WHERE consumed_at IS NULL;

-- ── refresh_tokens ──────────────────────────────────────────────────
-- Refresh tokens are stored hashed; raw token only leaves the server
-- once at issue time. Revoking = setting revoked_at.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  user_agent  TEXT,
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_expiry ON refresh_tokens(expires_at) WHERE revoked_at IS NULL;

-- ── updated_at trigger ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
