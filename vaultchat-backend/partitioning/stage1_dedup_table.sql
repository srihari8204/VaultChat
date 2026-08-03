-- stage1_dedup_table.sql — move send-dedup off the messages table (P4.1).
-- NOT an auto-run migration: apply manually, then deploy the chats_helpers.go
-- insert-path change described in PARTITION_RUNBOOK.md, soak, and only then
-- uncomment the DROP at the bottom on a second pass.

BEGIN;

CREATE TABLE IF NOT EXISTS message_client_ids (
  chat_id    UUID        NOT NULL,
  sender_id  UUID        NOT NULL,
  client_id  TEXT        NOT NULL,
  message_id BIGINT      NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, sender_id, client_id)
);

-- Backfill from live rows (idempotent; keeps the newest message per key,
-- matching the ON CONFLICT DO NOTHING semantics of the 055 index).
INSERT INTO message_client_ids (chat_id, sender_id, client_id, message_id, created_at)
SELECT m.chat_id, m.sender_id, m.client_id, m.id, m.created_at
  FROM messages m
 WHERE m.client_id IS NOT NULL
ON CONFLICT (chat_id, sender_id, client_id) DO NOTHING;

-- Retention: dedup only has to survive client retry windows. 30 days is
-- orders of magnitude beyond the messageQueue backoff cap (60 s holds).
-- Wire into the jobs sweeper alongside the other batched sweeps:
--   DELETE FROM message_client_ids
--    WHERE ctid IN (SELECT ctid FROM message_client_ids
--                    WHERE created_at < NOW() - INTERVAL '30 days' LIMIT 5000);

COMMIT;

-- ── SECOND PASS ONLY (after the Go insert path uses message_client_ids) ──
-- DROP INDEX IF EXISTS ux_messages_client_dedup;   -- the 055 unique index
