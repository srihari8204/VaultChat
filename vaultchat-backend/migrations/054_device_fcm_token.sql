-- 054_device_fcm_token.sql — store the raw native FCM token per device, used to
-- send data-only call wake-up pushes (separate from the Expo push token).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS fcm_token TEXT;
CREATE INDEX IF NOT EXISTS idx_devices_fcm ON devices (fcm_token) WHERE fcm_token IS NOT NULL;
