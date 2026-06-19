-- 045_chat_notif_sound.sql
-- Per-chat notification sound. NULL = the default channel/sound. The value is
-- a notification channelId the client registered (e.g. 'chime', 'bell'); the
-- push sender passes it through so each recipient hears their chosen sound.

ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS notif_sound TEXT;
