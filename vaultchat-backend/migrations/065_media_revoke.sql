-- VaultChat: sender-initiated media revoke (VaultView).
-- Idempotent.
--
-- attachments.revoked_at — stamped by the OWNER (sender) calling
--                          POST /uploads/:id/revoke. One-way: never cleared.
--                          Once set, GET /uploads/:id returns 410 Gone to
--                          EVERYONE including the owner, and the stored bytes
--                          are deleted from the object store / disk by the
--                          route. There is no undo and no backup.
--
-- This differs from view_once/viewed_at in who fires it and what it destroys:
--   view_once + viewed_at — the RECIPIENT consumes it by looking; bytes stay
--                           until the retention sweeper runs.
--   revoked_at            — the SENDER destroys it on demand; bytes go now.
--
-- The recipient's copy is handled client-side: the server broadcasts
-- 'media_revoked' over the chat socket, and clients destroy the per-file media
-- key plus any decrypted plaintext. An OFFLINE recipient converges on next
-- fetch — the 410 is the signal, and the client wipes on seeing it. With
-- MEDIA_E2EE on, destroying the key makes any ciphertext they already hold
-- permanently undecryptable.

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Partial index: the sweeper and the revoke path only ever look for live rows.
CREATE INDEX IF NOT EXISTS idx_attachments_revoked
  ON attachments(id)
  WHERE revoked_at IS NOT NULL;
