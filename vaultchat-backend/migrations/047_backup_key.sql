-- 047_backup_key.sql
-- Account-managed backup key (WhatsApp default model). A random per-user key the
-- server generates + stores and hands back after authentication, so backup &
-- restore need NO passphrase — the user just signs in. (For true zero-knowledge
-- E2E backups the app still offers a passphrase-encrypted file export.)

CREATE TABLE IF NOT EXISTS user_backup_keys (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dek        TEXT        NOT NULL,         -- base64 256-bit data-encryption key
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
