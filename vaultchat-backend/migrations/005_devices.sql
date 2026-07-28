-- VaultChat Day 2: devices (push notification tokens).
-- Idempotent — safe to re-run.
--
-- One row per (user, push_token). A user can have many devices (phone,
-- tablet, web), each registered with its own Expo push token.
--
-- RLS deliberately NOT enabled here — push tokens are needed by the
-- system push-send code which doesn't run with a per-user context.
-- Route-level access control (POST /user/devices, DELETE /user/devices/:id)
-- ensures users can only manage their own. Defense-in-depth via RLS
-- would require a SECURITY DEFINER helper similar to vc_chat_member_ids().

CREATE TABLE IF NOT EXISTS devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  push_token      TEXT NOT NULL,                                       -- Expo push token (ExponentPushToken[...])
  platform        TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
  device_name     TEXT,                                                -- "Pixel 6" / "iPhone 15" / "Chrome"
  app_version     TEXT,                                                -- e.g. "1.1.0"
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, push_token)
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
-- Cleanup query for stale devices (manual, run monthly via cron):
--   DELETE FROM devices WHERE last_seen_at < NOW() - INTERVAL '60 days';
