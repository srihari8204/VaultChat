-- VaultChat: chat-level disappearing-messages timer.
-- Idempotent.
--
-- chats.disappearing_seconds  — NULL = off. Set by an admin (group) or
--                               either member (direct). When non-null,
--                               every new message in that chat gets
--                               messages.expires_at = NOW() + interval.
--
-- messages.expires_at         — NULL = persists forever. Otherwise the
--                               server filters expired rows out of
--                               /messages GETs AND a background sweeper
--                               hard-deletes them every ~5 minutes.
--
-- Hard delete (not soft) is the user expectation here — disappearing
-- messages should leave no trace. Hosts that need audit logs would
-- keep retention elsewhere; this column is the user-facing contract.

ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS disappearing_seconds INTEGER;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_expires_at
  ON messages(expires_at)
  WHERE expires_at IS NOT NULL;
