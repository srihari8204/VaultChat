-- 068_sync_devices.sql — cold-sync guard state. Idempotent.
--
-- GET /chats/delta?since=0 is a complete history export: the cursor floor of 0
-- matches every message the caller is a member of, so one authenticated loop
-- drains the account. A fresh install legitimately asks for exactly that, which
-- is precisely why it cannot be told apart from a stolen refresh token — the
-- request is identical.
--
-- This table gives the server the missing signal: which INSTALLS it has seen
-- sync before. A `since=0` from a device_id already recorded here is a resumed
-- client. A `since=0` from an unrecorded one is a cold start — either a genuine
-- reinstall or an exfiltration attempt — and is answered with a bounded window
-- of recent history instead of everything (see COLD_SYNC_MAX_MESSAGES).
--
-- `device_id` is the client's per-install id (services/deviceService), which
-- lives in the OS keystore and is destroyed by uninstall. That is deliberate: a
-- reinstall SHOULD look like a new device, because from a data-minimisation
-- standpoint it is one.
--
-- This is also the audit trail — cold_sync_count and last_cold_sync_at answer
-- "how many times has this account been drained from scratch, and when".

CREATE TABLE IF NOT EXISTS user_sync_devices (
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id         TEXT        NOT NULL,           -- opaque per-install id from the client
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_cold_sync_at TIMESTAMPTZ,                    -- most recent since=0 request
  cold_sync_count   INTEGER     NOT NULL DEFAULT 0, -- how many full-history starts
  PRIMARY KEY (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sync_devices_user ON user_sync_devices (user_id);

-- Reviewing recent cold syncs across the fleet:
--   SELECT user_id, device_id, last_cold_sync_at, cold_sync_count
--     FROM user_sync_devices
--    WHERE last_cold_sync_at > NOW() - INTERVAL '24 hours'
--    ORDER BY last_cold_sync_at DESC;
