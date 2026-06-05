-- VaultChat: server-side scheduled messages (replaces Firestore stub).
-- Idempotent.
--
-- One row per pending scheduled message. When server.js's worker finds
-- a row with send_at <= NOW() AND sent_at IS NULL, it:
--   1. Re-verifies the sender is still a chat member (no leak after leave)
--   2. INSERTs a real row into `messages`
--   3. Updates chats.last_message_id / last_message_at
--   4. Stamps sent_at on this row (kept for audit; pruned daily later)
--   5. Broadcasts new_message via the same fan-out used by /messages POST
--
-- Sent rows older than 30 days are pruned by the same sweep loop.

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     UUID        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL DEFAULT 'text'
                CHECK (type IN ('text','image','video','audio','file','location','system')),
  content     TEXT,
  meta        JSONB,
  reply_to_id BIGINT      REFERENCES messages(id) ON DELETE SET NULL,
  send_at     TIMESTAMPTZ NOT NULL,
  sent_at     TIMESTAMPTZ,
  message_id  BIGINT      REFERENCES messages(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Worker sweep uses this index: rows due now, not yet sent.
CREATE INDEX IF NOT EXISTS idx_scheduled_pending
  ON scheduled_messages(send_at)
  WHERE sent_at IS NULL;

-- Owner list queries use this index.
CREATE INDEX IF NOT EXISTS idx_scheduled_user
  ON scheduled_messages(user_id, send_at);
