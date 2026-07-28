-- VaultChat: per-user-per-chat screenshot policy.
-- Idempotent.
--
-- Modes:
--   allow         — no FLAG_SECURE; chat-mates are not notified.
--   allow_notify  — no FLAG_SECURE; when a screenshot fires, the client
--                   POSTs /chats/:id/screenshot-captured which broadcasts
--                   a socket banner to other members.
--   block         — FLAG_SECURE (Android) / black-frame (iOS); also
--                   broadcasts an attempt notification when the OS still
--                   fires the listener (iOS can't fully suppress).
--   block_silent  — FLAG_SECURE; no notification on attempt.
--
-- Default is 'block' to preserve today's app-wide behavior.
-- Per-member so each side of a chat has its own setting.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'chat_members' AND column_name = 'screenshot_mode'
  ) THEN
    ALTER TABLE chat_members
      ADD COLUMN screenshot_mode TEXT NOT NULL DEFAULT 'block';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_members_screenshot_mode_check'
  ) THEN
    ALTER TABLE chat_members ADD CONSTRAINT chat_members_screenshot_mode_check
      CHECK (screenshot_mode IN ('allow', 'allow_notify', 'block', 'block_silent'));
  END IF;
END $$;
