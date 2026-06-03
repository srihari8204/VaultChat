-- VaultChat Phase 3b foundation: prekey storage for X3DH key agreement.
-- Backend is intentionally crypto-agnostic — it stores opaque blobs that
-- the client interprets per the active protocol (libsignal / libsodium /
-- hand-rolled). Idempotent.
--
-- Schema:
--   * identity_keys   — one row per user, long-lived (rotated rarely)
--   * signed_prekeys  — one row per user, replaced periodically (~weekly).
--                       Carries the user's identity-key signature so peers
--                       can verify it before deriving a session.
--   * one_time_prekeys — N rows per user, consumed exactly once on fetch.
--                        Each one's `used_at` is stamped at consume time;
--                        consumed rows stay for audit until pruned (>30d).
--
-- Auth: route handlers are authoritative. They look up keys by user_id
-- from the JWT for writes, and free-look by user_id for reads. RLS is NOT
-- enabled here because the OTPK-consume path is a non-owner write (the
-- *fetcher* stamps used_at on the *owner's* row) and policies that allow
-- that get hairy. The /keybundle routes are the only writers.

CREATE TABLE IF NOT EXISTS identity_keys (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key_b64 TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS identity_keys_set_updated_at ON identity_keys;
CREATE TRIGGER identity_keys_set_updated_at
  BEFORE UPDATE ON identity_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── signed_prekeys ──────────────────────────────────────────
-- Exactly one current signed prekey per user. Older versions kept for
-- rollover (so in-flight bundles aren't invalidated mid-rotation).
CREATE TABLE IF NOT EXISTS signed_prekeys (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id         INTEGER     NOT NULL,
  public_key_b64 TEXT        NOT NULL,
  signature_b64  TEXT        NOT NULL,  -- signature by identity key
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at     TIMESTAMPTZ,
  UNIQUE (user_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_signed_prekeys_user_current
  ON signed_prekeys(user_id, created_at DESC)
  WHERE retired_at IS NULL;

-- ── one_time_prekeys ────────────────────────────────────────
-- Pool of single-use prekeys. Server hands one out per bundle fetch.
-- When the pool drops below MIN_PREKEYS (~10) the client uploads a
-- fresh batch.
CREATE TABLE IF NOT EXISTS one_time_prekeys (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id         INTEGER     NOT NULL,
  public_key_b64 TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at        TIMESTAMPTZ,
  UNIQUE (user_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_user_unused
  ON one_time_prekeys(user_id, id)
  WHERE used_at IS NULL;
