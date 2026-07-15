-- 058_vaultbeam_message_type.sql
-- Idempotent.
--
-- Extend messages.type to allow 'vaultbeam' — a large-file (VaultBeam / R2
-- relay) transfer that IS a chat message (WhatsApp model): the E2EE `content`
-- carries the transfer manifest (per-transfer key K_t + fileId + filename +
-- mime), and `meta` carries only opaque routing (transferId + size the server
-- already knows from vb_transfer). The bytes never touch this server.
--
-- Also (re)adds 'reaction' to the set: F4 turned reactions into type='reaction'
-- reference-messages, but the last CHECK that touched this column (022_polls)
-- pre-dates F4 and omitted 'reaction'. This migration makes the constraint a
-- strict SUPERSET of every type the app currently inserts, so it can only
-- ACCEPT previously-rejected rows — never reject a currently-valid one.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_name = 'messages_type_check'
  ) THEN
    ALTER TABLE messages DROP CONSTRAINT messages_type_check;
  END IF;
  ALTER TABLE messages ADD CONSTRAINT messages_type_check
    CHECK (type IN ('text','image','video','audio','file','location','system','sticker','poll','reaction','vaultbeam'));
END $$;

-- scheduled_messages never carries 'vaultbeam' (a transfer can't be deferred —
-- the file must stream at send time), but keep its CHECK a superset too so a
-- scheduled reaction/text never trips it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_name = 'scheduled_messages_type_check'
  ) THEN
    ALTER TABLE scheduled_messages DROP CONSTRAINT scheduled_messages_type_check;
  END IF;
  ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_type_check
    CHECK (type IN ('text','image','video','audio','file','location','system','sticker','poll','reaction'));
END $$;
