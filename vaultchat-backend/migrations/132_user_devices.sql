-- 132_user_devices.sql — Phase 1 of docs/LINKED_DEVICES_PLAN.md: a device as a
-- first-class, revocable principal. Idempotent, additive, and INERT: nothing in
-- the app writes or reads any of this yet. Applying it changes no behaviour.
--
-- §1 of the plan counts three unjoined notions of "device": `devices` (a push
-- registration), `refresh_tokens` (a sign-in session) and
-- `user_sync_devices.device_id` (a per-install id). This table is the missing
-- join row they all point at, so that "revoke this device" can one day mean one
-- transaction instead of three unrelated deletes.
--
-- NOT keyed by a new server-minted UUID. The identity is the client's existing
-- per-install id (services/deviceService, SHA-256 hex in SecureStore), which
-- `user_sync_devices` (068) and `chat_device_delivery` (078) already key on as
-- TEXT. Minting a second id would mean reconciling two namespaces across two
-- live tables for no gain; reusing this one keeps the columns below joinable to
-- what is already recorded. It stays self-asserted until the access JWT carries
-- a device claim — that is the other half of Phase 1 and it lives in auth.go,
-- not here.
--
-- Explicitly NOT in scope, per the plan: identity_keys / signed_prekeys /
-- one_time_prekeys keep their per-ACCOUNT keys (011_prekeys.sql), and
-- group_sender_keys (040) keeps its per-user grain. Widening those to
-- per-device is Phase 2/3 and is the change that can silently make live
-- messages undecryptable. Nothing in this file touches key material.

CREATE TABLE IF NOT EXISTS user_devices (
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT        NOT NULL,              -- per-install id; same namespace as user_sync_devices.device_id
  display_name TEXT,                              -- user-editable, "Shop laptop"
  platform     TEXT        CHECK (platform IS NULL OR platform IN ('ios','android','web')),
  linked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ,                       -- soft: revoking must not orphan the delivery pointers that block purges
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, device_id)
);

-- The Settings list: a user's live devices, newest first.
CREATE INDEX IF NOT EXISTS idx_user_devices_user_active
  ON user_devices (user_id, linked_at DESC) WHERE revoked_at IS NULL;

-- The join columns. Both NULLABLE with no default and no backfill: every
-- existing row stays NULL, every existing INSERT keeps working unchanged, and
-- the FK is not checked for NULLs. Making either NOT NULL is a later migration
-- that must follow the code that populates it, never precede it.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE devices        ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Composite FKs, so a session or push row can only name a device of its own
-- owner. ON DELETE SET NULL, not CASCADE: hard-deleting a device row must not
-- silently delete live sessions or push registrations — revocation is
-- revoked_at, and the code that does it should be explicit about both.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_device_fk') THEN
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT refresh_tokens_device_fk
      FOREIGN KEY (user_id, device_id) REFERENCES user_devices (user_id, device_id)
      ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_device_fk') THEN
    ALTER TABLE devices
      ADD CONSTRAINT devices_device_fk
      FOREIGN KEY (user_id, device_id) REFERENCES user_devices (user_id, device_id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device ON refresh_tokens (user_id, device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_device        ON devices        (user_id, device_id) WHERE device_id IS NOT NULL;

-- No FK from user_sync_devices (068) or chat_device_delivery (078). Those
-- tables already hold rows for installs that predate this table, so a FK would
-- either fail validation or have to be added NOT VALID and then block the next
-- legitimate cold sync from an unregistered install. They join by value; that
-- is enough until the JWT device claim makes registration mandatory.

-- ROLLBACK (apply in this order; safe because nothing reads these):
--   ALTER TABLE devices        DROP CONSTRAINT IF EXISTS devices_device_fk;
--   ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_device_fk;
--   DROP INDEX IF EXISTS idx_devices_device;
--   DROP INDEX IF EXISTS idx_refresh_tokens_device;
--   ALTER TABLE devices        DROP COLUMN IF EXISTS device_id;
--   ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS device_id;
--   DROP TABLE IF EXISTS user_devices;
