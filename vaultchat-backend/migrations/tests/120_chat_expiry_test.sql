-- 120_chat_expiry_test.sql — rehearses the reaper predicate against real rows.
--
-- This is the only place in the codebase that DELETES WHOLE CONVERSATIONS on a
-- timer, and it runs unattended every few minutes. The failure mode is not
-- "a few extra rows go": drop the `expires_at IS NOT NULL` clause and the
-- statement matches every chat on production.
--
-- So the assertions below are deliberately paranoid about the rows that must
-- SURVIVE, not just the one that must die:
--
--   * a chat with NULL expires_at  (every ordinary chat, and every "Until I
--     delete" / "Save this contact" code chat)
--   * a chat whose deadline is in the FUTURE
--
-- The predicate is copied verbatim from jobs.go expiredChatsSQL. If the two
-- ever drift, this file is testing a statement that no longer runs — keep them
-- identical.
--
-- Run against a throwaway copy of production's schema:
--   docker exec vaultchat-postgres-1 sh -c 'pg_dump -U vaultchat -s vaultchat > /tmp/s.sql'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d postgres -c 'CREATE DATABASE cetest'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d cetest -q -f /tmp/s.sql
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d cetest -v ON_ERROR_STOP=1 -f <this file>
--
-- Every assertion raises, so a non-zero exit means a real failure.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name)
VALUES ('00000000-0000-0000-0000-000000008120'::uuid, '+915550120', 'Expiry Test')
ON CONFLICT DO NOTHING;

-- Three chats: one ordinary (NULL), one due, one not due yet.
INSERT INTO chats (id, type, created_by, expires_at) VALUES
  ('00000000-0000-0000-0000-00000000e001'::uuid, 'direct',
   '00000000-0000-0000-0000-000000008120'::uuid, NULL),
  ('00000000-0000-0000-0000-00000000e002'::uuid, 'direct',
   '00000000-0000-0000-0000-000000008120'::uuid, now() - interval '1 minute'),
  ('00000000-0000-0000-0000-00000000e003'::uuid, 'direct',
   '00000000-0000-0000-0000-000000008120'::uuid, now() + interval '1 hour');

-- Give the doomed chat a member, to prove the cascade actually fires.
INSERT INTO chat_members (chat_id, user_id, role)
VALUES ('00000000-0000-0000-0000-00000000e002'::uuid,
        '00000000-0000-0000-0000-000000008120'::uuid, 'owner');

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM chat_members
   WHERE chat_id = '00000000-0000-0000-0000-00000000e002'::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'setup failed: member not inserted'; END IF;
END $$;

-- ── the reaper, verbatim from jobs.go expiredChatsSQL ────────────────
DELETE FROM chats
 WHERE ctid IN (
   SELECT ctid FROM chats
    WHERE expires_at IS NOT NULL
      AND expires_at <= now()
    LIMIT 500
 );

-- ── the due chat is gone ─────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM chats WHERE id = '00000000-0000-0000-0000-00000000e002'::uuid) THEN
    RAISE EXCEPTION 'an expired chat SURVIVED — the reaper does not work';
  END IF;
END $$;

-- ── ...and it took its members with it (CASCADE, not an orphan sweep) ─
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM chat_members
   WHERE chat_id = '00000000-0000-0000-0000-00000000e002'::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'chat deleted but % member row(s) orphaned — cascade missing', n;
  END IF;
END $$;

-- ── THE ORDINARY CHAT MUST SURVIVE ───────────────────────────────────
-- If this ever fails, the reaper deletes every conversation on the box.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chats WHERE id = '00000000-0000-0000-0000-00000000e001'::uuid) THEN
    RAISE EXCEPTION 'A CHAT WITH NULL expires_at WAS DELETED — this predicate would wipe production';
  END IF;
END $$;

-- ── a future deadline is not yet due ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chats WHERE id = '00000000-0000-0000-0000-00000000e003'::uuid) THEN
    RAISE EXCEPTION 'a chat expiring in an hour was deleted now';
  END IF;
END $$;

ROLLBACK;
