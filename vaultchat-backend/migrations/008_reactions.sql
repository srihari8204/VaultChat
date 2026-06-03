-- VaultChat Day 8: message_reactions.
-- Idempotent — safe to re-run.
--
-- Run with:
--   psql -h 127.0.0.1 -p 6432 -U vaultchat_app -d vaultchat -f migrations/008_reactions.sql
--
-- One row per (message, user, emoji). A user can stack different emojis on
-- the same message but cannot duplicate the same emoji. RLS piggybacks on
-- chat membership: you can read/write a reaction iff you're a member of
-- the message's chat.

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id   BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  emoji        TEXT        NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);

ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

-- Members of the chat owning the message can SELECT.
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = message_reactions.message_id
        AND vc_is_chat_member(m.chat_id)
    )
  );

-- Only the acting user can insert their own reaction, and only on
-- messages in chats they're a member of.
DROP POLICY IF EXISTS message_reactions_insert ON message_reactions;
CREATE POLICY message_reactions_insert ON message_reactions
  FOR INSERT
  WITH CHECK (
    user_id = vc_current_user_id()
    AND EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = message_reactions.message_id
        AND vc_is_chat_member(m.chat_id)
    )
  );

-- Only the acting user can delete their own reaction.
DROP POLICY IF EXISTS message_reactions_delete ON message_reactions;
CREATE POLICY message_reactions_delete ON message_reactions
  FOR DELETE
  USING (user_id = vc_current_user_id());
