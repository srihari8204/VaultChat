-- VaultID — a stable, user-friendly public handle used for QR / link
-- contact adds (qr-contact screen). Idempotent.
--
-- The column is nullable: existing rows are backfilled here with a
-- deterministic handle derived from the (already-unique) user id, and any
-- user created later is lazily assigned a random handle the first time they
-- open GET /user/profile (see routes/user.js). A unique index enforces
-- global uniqueness while still permitting the transient NULL for a
-- brand-new row before its first profile fetch.

ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_id TEXT;

-- Backfill: 'v' + first 11 hex chars of the id (collision-free, since ids are).
UPDATE users
   SET vault_id = 'v' || substr(replace(id::text, '-', ''), 1, 11)
 WHERE vault_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_vault_id ON users(vault_id);
