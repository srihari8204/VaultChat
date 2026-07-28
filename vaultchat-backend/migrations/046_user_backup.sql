-- 046_user_backup.sql
-- Zero-knowledge encrypted chat backup (WhatsApp-style). The ciphertext is
-- produced client-side with the user's passphrase; the server can never read it.
--
-- The blob lives in OBJECT STORAGE (MinIO/S3) — the DB keeps only metadata +
-- the object key. This avoids storing huge blobs in Postgres / parsing them
-- through Express (which would cap and OOM as histories grow). `blob` is an
-- inline fallback used only when object storage is disabled (tiny deployments).

CREATE TABLE IF NOT EXISTS user_backups (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  storage_key   TEXT,                                  -- MinIO/S3 object key (preferred)
  blob          TEXT,                                  -- inline ciphertext fallback only
  size_bytes    BIGINT      NOT NULL DEFAULT 0,        -- plaintext size (display only)
  message_count INTEGER     NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
