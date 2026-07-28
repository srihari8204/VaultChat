-- 059_vaultlens.sql — VaultLens AI-avatar mini-app. Idempotent.
--
-- Two content-light tables:
--   vaultlens_face        one cached face reference per user (R2 key only — the
--                         selfie bytes live in R2, never in Postgres). Later
--                         generations reuse this, so they skip re-upload.
--   vaultlens_generation  one row per generation (client ULID as PK for
--                         reconciliation). Quota is DERIVED from this table
--                         (count today, excluding 'failed') — a failed job is
--                         auto-refunded simply by not counting.

CREATE TABLE IF NOT EXISTS vaultlens_face (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  storage_key  TEXT        NOT NULL,        -- R2 key of the cached selfie (vaultlens/faces/<user>.jpg)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vaultlens_generation (
  id           TEXT        PRIMARY KEY,      -- client-generated ULID (reconcile key)
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  style_id     TEXT        NOT NULL,
  pack_id      TEXT,
  status       TEXT        NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','processing','done','failed')),
  storage_key  TEXT,                          -- R2 key of the output (vaultlens/<user>/<id>.jpg)
  width        INT         NOT NULL DEFAULT 512,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Quota query hits (user_id, created_at) filtered on status; history hits
-- (user_id, created_at DESC).
CREATE INDEX IF NOT EXISTS idx_vaultlens_gen_user_created
  ON vaultlens_generation(user_id, created_at DESC);
