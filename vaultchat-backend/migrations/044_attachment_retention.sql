-- 044_attachment_retention.sql — WhatsApp-style media retention.
--
-- Media bytes live in object storage (MinIO) as before, but once every recipient
-- has downloaded an attachment (or after a hard TTL), a background sweeper purges
-- the bytes — the metadata row stays so the bubble still renders for anyone who
-- already cached it locally. Supports offline delivery: the bytes survive until
-- the recipient comes online and fetches them.

-- Per-recipient delivery log: one row when a non-owner first fetches the bytes.
CREATE TABLE IF NOT EXISTS attachment_deliveries (
  attachment_id UUID        NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  delivered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (attachment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_attachment_deliveries_att ON attachment_deliveries (attachment_id);

-- Marks when the bytes were purged from storage (NULL = still stored).
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

-- Sweeper looks up not-yet-purged attachments that still have a storage_path.
CREATE INDEX IF NOT EXISTS idx_attachments_purge_pending
  ON attachments (created_at)
  WHERE purged_at IS NULL;
