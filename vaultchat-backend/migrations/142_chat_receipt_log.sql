-- 142_chat_receipt_log.sql — when each member's delivered/read pointer moved,
-- so Message Info can show per-member delivered and read TIMES.
--
-- NOT APPLIED ANYWHERE. Written 2026-10-04 (round 4); scratch-DB only.
--
-- chat_members keeps one monotonic pointer per member (last_delivered_message_id,
-- last_read_message_id). That answers "has X read message M" but not "when".
-- Each time POST /chats/{id}/delivered or /read actually ADVANCES a pointer, the
-- server appends one row here (kind 'd' or 'r', the new pointer value, NOW()).
-- Because pointers only move forward, the time member X first covered message M
-- is the `at` of X's first row with message_id >= M — one primary-key probe.
--
-- GET /chats/{id}/messages/{msgId}/receipts reads it (sender only).
-- Rows are swept after 30 days (jobs: sweep-receipt-log). A message younger than
-- that always has its covering rows, since a pointer can only cross M after M
-- was sent; older messages keep the delivered/read state but lose the times.
-- Messages sent before this migration likewise show state without times.
--
-- No RLS: the only reader is the sender-scoped handler; the table carries ids
-- and timestamps only (no content). Additive, instant. Reverse:
--   DROP TABLE IF EXISTS chat_receipt_log;

CREATE TABLE IF NOT EXISTS chat_receipt_log (
  chat_id    UUID        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       CHAR(1)     NOT NULL CHECK (kind IN ('d', 'r')),
  message_id BIGINT      NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id, kind, message_id)
);

-- The sweep deletes by age.
CREATE INDEX IF NOT EXISTS idx_chat_receipt_log_at ON chat_receipt_log (at);
