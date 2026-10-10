-- 140_per_device_identity.sql — give every E2EE key a DEVICE, not just an owner.
--
-- THE BUG THIS EXISTS TO END.
--
-- identity_keys.user_id is a PRIMARY KEY (011_prekeys.sql:22), so an account has
-- exactly one published identity. POST /user/keybundle
-- (internal/routes/user.go:2638-2656) therefore does:
--
--     INSERT INTO identity_keys (user_id, public_key_b64) VALUES ($1, $2)
--       ON CONFLICT (user_id) DO UPDATE SET public_key_b64 = EXCLUDED....
--     -- and, when the key changed:
--     DELETE FROM one_time_prekeys WHERE user_id = $1;
--     UPDATE signed_prekeys SET retired_at = NOW() WHERE user_id = $1 ...;
--
-- So a SECOND install by the same person — a new phone, a reinstall after a crash,
-- clearing app data — overwrites their own identity key, deletes every one-time
-- prekey including the first device's, and retires the first device's signed
-- prekey. Peers who already hold a session keep working until they re-key; new
-- senders fetch the new bundle and the old device becomes unreachable. The user
-- sees conversations stop decrypting, with no error that explains why.
--
-- "One phone per user" was never a UX limitation waiting for a feature. It is
-- enforced by this schema, and undoing it is the architectural work.
--
-- WHY NOW, WITH FOUR ACCOUNTS. You cannot derive which device an existing
-- account-level identity key belongs to, so converting later means re-keying every
-- user: everyone re-verifies safety numbers and loses session continuity on the
-- same day. At four self-owned accounts that costs nothing. The repo's own parity
-- notes put it plainly — do this before launch or it is "a rewrite, not a
-- migration".
--
-- THIS MIGRATION CHANGES NO BEHAVIOUR. It is deliberately additive:
--
--   * device_id is TEXT NOT NULL DEFAULT '' — the empty string is the LEGACY row,
--     meaning "published before this account had per-device identity".
--   * the current server sends no device id, so it writes and reads device_id = ''
--     and keeps hitting exactly the row it hit before. Same upsert, same purge,
--     same single-device behaviour.
--   * nothing is dropped, nothing is rewritten, no row moves.
--
-- What it buys is the SHAPE: once the access token carries a device claim (the
-- other half of LINKED_DEVICES_PLAN phase 1), the handlers can start writing a
-- real device id and two devices stop colliding. Landing the schema first means
-- that change is a code change rather than a flag day.
--
-- NO FOREIGN KEY TO user_devices, deliberately, unlike migration 132's
-- refresh_tokens/devices constraints. A composite FK would require a user_devices
-- row to exist BEFORE a keybundle publish, and nothing creates one yet — adding it
-- now would reject every publish and break sign-up. The FK belongs in the same
-- change that starts populating user_devices.
--
-- device_id shares the namespace established by 132_user_devices.sql and
-- 068_sync_devices.sql (services/deviceService.ts: a SHA-256 hex id in SecureStore,
-- destroyed by uninstall). Do not invent a second one.
--
-- ROLLBACK: see down/140_per_device_identity.down.sql. It is safe only while every
-- row is still device_id = '' — once real device ids exist, dropping the column
-- merges distinct devices' keys into one row and corrupts identity. The down
-- script refuses rather than guessing.

-- ── identity_keys: one row per (account, device) ──────────────────────
ALTER TABLE identity_keys ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT '';

-- Repoint the primary key. Guarded so a re-run is a no-op, like every other
-- migration in this directory.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'identity_keys' AND c.contype = 'p'
       AND (SELECT count(*) FROM unnest(c.conkey)) = 1
  ) THEN
    ALTER TABLE identity_keys DROP CONSTRAINT identity_keys_pkey;
    ALTER TABLE identity_keys ADD CONSTRAINT identity_keys_pkey
      PRIMARY KEY (user_id, device_id);
  END IF;
END $$;

-- ── signed_prekeys: a key id is unique per device, not per account ────
ALTER TABLE signed_prekeys ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signed_prekeys_user_id_key_id_key') THEN
    ALTER TABLE signed_prekeys DROP CONSTRAINT signed_prekeys_user_id_key_id_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signed_prekeys_user_device_key') THEN
    ALTER TABLE signed_prekeys ADD CONSTRAINT signed_prekeys_user_device_key
      UNIQUE (user_id, device_id, key_id);
  END IF;
END $$;

-- The "current signed prekey" lookup is now per device. The old index stays valid
-- for the legacy row and is simply narrower than this one.
CREATE INDEX IF NOT EXISTS idx_signed_prekeys_device_current
  ON signed_prekeys (user_id, device_id, created_at DESC)
  WHERE retired_at IS NULL;

-- ── one_time_prekeys: a pool per device ──────────────────────────────
ALTER TABLE one_time_prekeys ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'one_time_prekeys_user_id_key_id_key') THEN
    ALTER TABLE one_time_prekeys DROP CONSTRAINT one_time_prekeys_user_id_key_id_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'one_time_prekeys_user_device_key') THEN
    ALTER TABLE one_time_prekeys ADD CONSTRAINT one_time_prekeys_user_device_key
      UNIQUE (user_id, device_id, key_id);
  END IF;
END $$;

-- Handing out an unused prekey is the hot path on every first contact, and it is
-- now scoped to a device.
CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_device_unused
  ON one_time_prekeys (user_id, device_id)
  WHERE used_at IS NULL;

-- ── group sender keys are NOT touched ────────────────────────────────
-- group_sender_keys is addressed per RECIPIENT, and a sender key rides the
-- pairwise session to each one. It becomes per-device for free once the pairwise
-- layer is, so widening it here would be a column nothing reads.
