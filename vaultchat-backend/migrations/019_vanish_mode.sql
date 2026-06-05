-- VaultChat: Vanish Mode — messages disappear after every recipient has
-- read them (vs. disappearing-messages which fires on a wall-clock timer
-- starting at send time, regardless of read state).
-- Idempotent.
--
-- Two columns:
--   * messages.vanish_after_read       — stamped at INSERT time from the
--                                        sender's chat_members.vanish_mode
--                                        flag. Once stamped, the value
--                                        is sticky on that message.
--   * chat_members.vanish_mode         — per-user toggle. While true,
--                                        every new message you send in
--                                        this chat gets vanish_after_read.
--
-- Trigger logic lives in routes/chats.js POST /:id/read: when a member
-- advances their last_read pointer, we check whether any vanish_after_read
-- messages in this chat now have ALL non-sender members at or past their
-- id, and if so set their expires_at = NOW(). The existing 5-minute
-- sweep loop in server.js then hard-deletes them on its next pass.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS vanish_after_read BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS vanish_mode BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index makes the "vanish messages still pending all-read" lookup
-- cheap. Rows transition out of this index once expires_at is set.
CREATE INDEX IF NOT EXISTS idx_messages_vanish_pending
  ON messages(chat_id, id)
  WHERE vanish_after_read = TRUE AND expires_at IS NULL;
