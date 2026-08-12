-- 100_drop_messages_content.sql — CONTRACT PHASE. NOT APPLIED.
--
-- Read migrations/contract-pending/README.md first. This file is irreversible.
--
-- It removes the last permanent home of message ciphertext on the server.
-- After 099 every NEW message writes its payload to the ephemeral, partitioned
-- message_bodies; `messages.content` survives only to keep two things working
-- during the soak:
--
--   1. messages written BEFORE the cutover, which have no body row
--   2. clients deployed before the body-aware build, via the
--      COALESCE(b.content, m.content) fallback in chatsMsgSelBody
--
-- Dropping the column ends both. That is the intent — it is what makes the
-- three-hour retention guarantee true for the whole table rather than for
-- messages sent after a particular date — but it is also why this cannot run
-- until the fleet has migrated.
--
-- PRE-FLIGHT. Run these first; every one must answer as annotated.
--
--   -- Legacy rows still holding ciphertext. This is what will be DESTROYED.
--   SELECT count(*) FROM messages WHERE content IS NOT NULL;
--       → expect 0. Non-zero is the number of messages that become permanently
--         unreadable for any recipient that never received them. It should
--         reach 0 on its own: DELETE_ON_DELIVERY_MAX_AGE_DAYS nulls delivered
--         legacy bodies, and undelivered ones age out.
--
--   -- Bodies in the new store, i.e. proof the writer is actually on.
--   SELECT count(*) FROM message_bodies;
--       → expect > 0 on a system with traffic. Zero means MESSAGE_BODIES was
--         never enabled and this migration would delete the only copy there is.
--
--   -- Overdue bodies: the retention sweep's health.
--   SELECT count(*) FROM message_bodies WHERE body_expires_at <= NOW();
--       → expect ~0. A persistent non-zero value means expiry has stopped and
--         the guarantee is already not being met; fix that before contracting.
--
-- DO NOT run this in the same deploy as the code change that removes the
-- COALESCE fallback. Ship the code first, confirm it, then drop the column —
-- otherwise a rollback of the code lands on a schema that can no longer serve
-- it.

BEGIN;

-- Refuse to run if the new store is empty. A guard rather than a comment,
-- because the failure mode is silent and total: dropping the column on a
-- deployment where bodies were never written destroys every message.
DO $$
DECLARE
  n_bodies BIGINT;
BEGIN
  SELECT count(*) INTO n_bodies FROM message_bodies;
  IF n_bodies = 0 THEN
    RAISE EXCEPTION
      'refusing to drop messages.content: message_bodies is EMPTY — MESSAGE_BODIES was never enabled, so this column is still the only copy of every message';
  END IF;
END $$;

ALTER TABLE messages DROP COLUMN IF EXISTS content;

COMMIT;

-- AFTER: chatsMsgCols in internal/routes/chats.go must no longer select
-- `content` from `messages`, and chatsMsgSelBody's COALESCE collapses to
-- `b.content AS content`. Both are compile-visible; the query is not.
