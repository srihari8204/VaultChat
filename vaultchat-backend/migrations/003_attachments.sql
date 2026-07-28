-- VaultChat Phase 4: attachments (images / files / audio in messages).
-- Idempotent — safe to re-run.
--
-- Run with:
--   psql -h 127.0.0.1 -p 6432 -U vaultchat_app -d vaultchat -f migrations/003_attachments.sql
--
-- Model:
--   Attachment row created at upload time, linked into messages via
--   messages.meta->>'attachmentId'. One row per uploaded file.
--   Storage path is relative to the configured UPLOAD_DIR — no absolute
--   paths in the DB so we can move the upload root without a migration.

CREATE TABLE IF NOT EXISTS attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  storage_path    TEXT NOT NULL,     -- relative to UPLOAD_DIR, e.g. "2026/06/01/abc.jpg"
  -- E2EE marker. NULL today (Phase 4 ships plaintext). When Phase 4b lands,
  -- this carries the encryption scheme + nonce so clients know how to decrypt.
  enc_scheme      TEXT,
  enc_meta        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_user_id);
