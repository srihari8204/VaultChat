-- VaultChat: per-user hidden chats.
-- Idempotent.
--
-- A chat marked hidden by a user is excluded from the default GET /chats
-- response and from the chat-list socket refresh. It still receives push
-- notifications and message broadcasts — hiding is a UI affordance, not
-- a mute. The chat is reachable via /hidden-chats (PIN-gated) and the
-- user can flip back via the chat header menu.
--
-- Per-member (not per-chat) so each side of a chat can hide independently.
-- Distinct from `archived` because archived chats still appear in the
-- Archive folder of the regular chat list, while hidden chats are
-- invisible until the user enters their PIN.

ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_chat_members_hidden
  ON chat_members(user_id)
  WHERE left_at IS NULL AND hidden = TRUE;
