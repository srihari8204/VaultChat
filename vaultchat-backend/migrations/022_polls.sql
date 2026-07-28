-- VaultChat: in-chat polls.
-- Idempotent.
--
-- A poll IS a message with type='poll'. It does NOT need its own polls
-- table — we ride on the existing messages row:
--   * content                  → the question (≤ 200 chars; backend validates)
--   * meta.options              → string[] of choice labels (2–10)
--   * meta.allowMultiple        → boolean; single-vote when false
--
-- Votes live in poll_votes, keyed by (message_id, user_id, option_index).
-- For single-vote polls the (message_id, user_id) pair is unique — the
-- backend enforces that with an EXCLUDE-on-INSERT path (see PRIMARY KEY).
-- For allowMultiple polls a voter can hold multiple rows.

-- 1) Extend the messages.type CHECK to allow 'poll'.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_name = 'messages_type_check'
  ) THEN
    ALTER TABLE messages DROP CONSTRAINT messages_type_check;
  END IF;
  ALTER TABLE messages ADD CONSTRAINT messages_type_check
    CHECK (type IN ('text','image','video','audio','file','location','system','sticker','poll'));
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_name = 'scheduled_messages_type_check'
  ) THEN
    ALTER TABLE scheduled_messages DROP CONSTRAINT scheduled_messages_type_check;
  END IF;
  ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_type_check
    CHECK (type IN ('text','image','video','audio','file','location','system','sticker','poll'));
END $$;

-- 2) poll_votes
--    Composite PK enforces idempotent single-row-per-(poll, user, option).
--    "Single-vote" polls are enforced by the application: route refuses
--    a second INSERT when the message's meta.allowMultiple is false.
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id    BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  option_index  SMALLINT    NOT NULL CHECK (option_index >= 0 AND option_index < 100),
  voted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, option_index)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_message
  ON poll_votes(message_id);
