-- VaultChat: one pinned message per chat (W15). Idempotent.
-- The pin is chat-wide (synced to all members), cleared if the message is deleted.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS pinned_message_id BIGINT;
