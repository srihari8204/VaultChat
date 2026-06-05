-- VaultChat: view-once media (WhatsApp-style ephemeral attachments).
-- Idempotent.
--
-- attachments.view_once   — set by uploader. When TRUE the first non-owner
--                           viewer triggers a one-way flip of viewed_at;
--                           subsequent GETs from non-owners return 410.
--                           Owners (sender) can always re-fetch their
--                           own uploads regardless of view_once state.
-- attachments.viewed_at   — stamped exactly once, by the first non-owner
--                           recipient who opens the bubble. Never cleared.

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS view_once BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_attachments_view_once_pending
  ON attachments(id)
  WHERE view_once = TRUE AND viewed_at IS NULL;
