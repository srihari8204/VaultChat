-- 078_device_delivery.sql — PER-DEVICE delivery pointers. Idempotent.
--
-- WHY
-- ---
-- delete-on-delivery (internal/jobs: sweepDeliveredMessages) nulls a message
-- body once every other member has received it. Its safety check reads
-- chat_members.last_delivered_message_id — which is ONE row per (chat, USER).
--
-- With more than one device on an account that is data loss, not an
-- optimisation: phone A acks the message, the pointer advances, the sweep nulls
-- the body, and tablet B — which never received it — has nothing left to fetch.
-- The message is gone from the server and was never on B. Nothing recovers it.
--
-- This table moves the pointer down to the DEVICE, so "delivered" can mean
-- "delivered to every device that is actually using this account".
--
-- STALENESS IS THE OTHER HALF
-- ---------------------------
-- Requiring EVERY device that ever existed to ack would be the opposite bug: a
-- phone that was lost, sold or wiped would pin the account's whole history on
-- the server forever, which is exactly what delete-on-delivery exists to avoid.
-- The sweep therefore only counts devices seen recently (see
-- DELETE_ON_DELIVERY_DEVICE_STALE_DAYS, default 30) using user_sync_devices
-- .last_sync_at — the same install identity added in 068.
--
-- device_id is the client's per-install id (services/deviceService), destroyed
-- by uninstall — so a reinstall is correctly treated as a new device.
--
-- MIGRATION SAFETY
-- ----------------
-- chat_members.last_delivered_message_id is deliberately LEFT IN PLACE and
-- still maintained. It drives read/delivery receipts in the UI, and keeping it
-- means this table can be introduced while the sweep is still disabled, be
-- back-filled by normal traffic, and be switched to only when it has coverage.
-- Rolling back is dropping this table; nothing else depends on it yet.

CREATE TABLE IF NOT EXISTS chat_device_delivery (
  chat_id                   UUID        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id                   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id                 TEXT        NOT NULL,   -- per-install id, matches user_sync_devices
  last_delivered_message_id BIGINT      NOT NULL DEFAULT 0,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id, device_id)
);

-- The sweep asks "is there any active device of a member that is BEHIND this
-- message id" — a per-chat lookup filtered by id.
CREATE INDEX IF NOT EXISTS idx_chat_device_delivery_chat
  ON chat_device_delivery (chat_id, last_delivered_message_id);

-- Fleet questions ("which of my devices is behind?") go the other way.
CREATE INDEX IF NOT EXISTS idx_chat_device_delivery_user
  ON chat_device_delivery (user_id, device_id);

-- Devices that have not synced within the staleness window, and would
-- therefore be ignored by the sweep:
--   SELECT d.user_id, d.device_id, d.last_sync_at
--     FROM user_sync_devices d
--    WHERE d.last_sync_at < NOW() - INTERVAL '30 days'
--    ORDER BY d.last_sync_at;
