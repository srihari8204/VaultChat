-- down/140_per_device_identity.sql — reverse the per-device key columns.
--
-- SAFE ONLY WHILE EVERY ROW IS STILL device_id = '', and this script REFUSES
-- rather than guessing.
--
-- Dropping device_id merges distinct devices' keys into one row. For
-- identity_keys that is not a lossy convenience, it is identity corruption: two
-- devices' public keys collapse onto one account row, the surviving one is
-- whichever the collapse happens to keep, and every peer holding a session with
-- the loser silently cannot decrypt. For the prekey tables it reintroduces the
-- (user_id, key_id) collision that 140 removed, so two devices that both minted
-- key_id 1 cannot coexist and the restore of the UNIQUE constraint fails anyway —
-- after the column is already gone.
--
-- So: if any real device id exists, this is not a rollback, it is a data loss
-- event dressed as one. Abort and write a forward migration instead.
--
-- While still all-legacy (the state immediately after 140 lands, before the
-- access token carries a device claim) this is exact: every row is device_id = '',
-- so dropping the column cannot merge anything, and the original single-column
-- key and UNIQUE constraints are restored byte-for-byte.

DO $$
DECLARE n BIGINT;
BEGIN
  SELECT (SELECT count(*) FROM identity_keys    WHERE device_id <> '')
       + (SELECT count(*) FROM signed_prekeys   WHERE device_id <> '')
       + (SELECT count(*) FROM one_time_prekeys WHERE device_id <> '')
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      '140 down refused: % row(s) carry a real device_id. Dropping the column '
      'would merge two devices'' identities onto one account row and silently '
      'break every peer session with the loser. Write a forward migration.', n;
  END IF;
END $$;

-- ── one_time_prekeys ─────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_one_time_prekeys_device_unused;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'one_time_prekeys_user_device_key') THEN
    ALTER TABLE one_time_prekeys DROP CONSTRAINT one_time_prekeys_user_device_key;
  END IF;
END $$;
ALTER TABLE one_time_prekeys DROP COLUMN IF EXISTS device_id;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'one_time_prekeys_user_id_key_id_key') THEN
    ALTER TABLE one_time_prekeys ADD CONSTRAINT one_time_prekeys_user_id_key_id_key
      UNIQUE (user_id, key_id);
  END IF;
END $$;

-- ── signed_prekeys ───────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_signed_prekeys_device_current;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signed_prekeys_user_device_key') THEN
    ALTER TABLE signed_prekeys DROP CONSTRAINT signed_prekeys_user_device_key;
  END IF;
END $$;
ALTER TABLE signed_prekeys DROP COLUMN IF EXISTS device_id;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signed_prekeys_user_id_key_id_key') THEN
    ALTER TABLE signed_prekeys ADD CONSTRAINT signed_prekeys_user_id_key_id_key
      UNIQUE (user_id, key_id);
  END IF;
END $$;

-- ── identity_keys ────────────────────────────────────────────────────
-- The composite PK goes before the column it spans, then the original
-- single-column PK is restored.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'identity_keys' AND c.contype = 'p'
       AND (SELECT count(*) FROM unnest(c.conkey)) = 2
  ) THEN
    ALTER TABLE identity_keys DROP CONSTRAINT identity_keys_pkey;
  END IF;
END $$;
ALTER TABLE identity_keys DROP COLUMN IF EXISTS device_id;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'identity_keys' AND c.contype = 'p'
  ) THEN
    ALTER TABLE identity_keys ADD CONSTRAINT identity_keys_pkey PRIMARY KEY (user_id);
  END IF;
END $$;
