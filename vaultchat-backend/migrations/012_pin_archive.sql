-- VaultChat: pin + archive per chat member (P1 polish, 2026-06-04).
-- Idempotent.
--
-- Pin and archive are intentionally per-(chat,user) on chat_members so
-- each member maintains their own view. Pinned chats sort to the top of
-- the chat list within their folder; archived chats are hidden from the
-- default folder but appear under the Archive folder filter.

ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS pinned    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archived  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

-- Index supports the "Pinned" folder query (active members, pinned, latest first)
CREATE INDEX IF NOT EXISTS idx_chat_members_pinned
  ON chat_members(user_id, pinned_at DESC)
  WHERE left_at IS NULL AND pinned = TRUE;

-- Index supports the "Archive" folder query
CREATE INDEX IF NOT EXISTS idx_chat_members_archived
  ON chat_members(user_id)
  WHERE left_at IS NULL AND archived = TRUE;
