-- test-call-rls.sql — assertions for the 066 call-session RLS model.
--
-- Run it through scripts/test-call-rls.sh, which seeds the fixtures as an admin
-- role and then runs THIS file as the app role. The split is not incidental:
-- RLS does not apply to a superuser or to a table's owner, so running the
-- assertions as either would pass everything while proving nothing.
--
-- Expects the fixtures (three users, one chat, two members) to already exist.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- The first version of 066 wrote the participant UPDATE policy as an inline
-- `EXISTS (SELECT 1 FROM call_participants ...)`. That is valid SQL, the
-- migration applied without complaint, and every UPDATE then failed at runtime
-- with "infinite recursion detected in policy" — the policy queried the table it
-- was guarding. No amount of reading catches that; a live database catches it
-- immediately. Same for the role-escalation guard: the policy alone let an
-- audience member set their own role, because "you may edit your own row" and
-- "you may not change this column" are different statements.

\set QUIET on
\set ANN  '''aaaaaaaa-0000-4000-8000-0000000000a1'''
\set BOB  '''bbbbbbbb-0000-4000-8000-0000000000b1'''
\set EVE  '''eeeeeeee-0000-4000-8000-0000000000e1'''
\set CHAT '''cccccccc-0000-4000-8000-0000000000c1'''
\set CALL '''dddddddd-0000-4000-8000-0000000000d1'''

\pset tuples_only on
\pset format unaligned
\echo '── call-session RLS ──'

-- assert(condition, label) — raises, so ON_ERROR_STOP aborts on the first miss.
SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.ck(ok BOOLEAN, label TEXT) RETURNS VOID AS $$
BEGIN
  IF ok THEN RAISE NOTICE '  ✓ %', label;
  ELSE RAISE EXCEPTION '  ✗ %', label;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Run `stmt` as `uid` and report whether it was REFUSED.
--
-- Refusal has two legitimate shapes and this accepts both: the database RAISES,
-- or a USING clause that matches nothing silently updates zero rows.
--
-- It deliberately does NOT catch every exception. An earlier version did, and a
-- recursive policy — which fails with "infinite recursion detected in policy" on
-- EVERY update — was therefore scored as a successful refusal. Only the three
-- SQLSTATEs that mean "the database said no on purpose" count:
--
--   insufficient_privilege (42501) — an RLS WITH CHECK, or the role trigger
--   check_violation        (23514) — the role CHECK constraint
--   unique_violation       (23505) — the one-live-call-per-chat index
--
-- Anything else re-raises and aborts the run, which is what turns that false
-- pass into the failure it should always have been.
CREATE OR REPLACE FUNCTION pg_temp.refused(uid TEXT, stmt TEXT) RETURNS BOOLEAN AS $$
DECLARE n INT;
BEGIN
  PERFORM set_config('app.current_user_id', uid, true);
  EXECUTE stmt;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 0;
EXCEPTION
  WHEN insufficient_privilege OR check_violation OR unique_violation THEN RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

BEGIN;
SET LOCAL app.current_user_id = :ANN;
INSERT INTO calls (id, chat_id, started_by, kind) VALUES (:CALL, :CHAT, :ANN, 'video');
SELECT pg_temp.ck(TRUE, 'a chat member may open a call');

SELECT pg_temp.ck(
  pg_temp.refused(:EVE, format('INSERT INTO calls (chat_id, started_by) VALUES (%L, %L)', :CHAT, :EVE)),
  'a NON-member may not open a call in that chat');
SELECT pg_temp.ck(
  pg_temp.refused(:BOB, format('INSERT INTO calls (chat_id, started_by) VALUES (%L, %L)', :CHAT, :ANN)),
  'a member may not open a call attributed to someone else');
SELECT pg_temp.ck(
  pg_temp.refused(:ANN, format('INSERT INTO calls (chat_id, started_by) VALUES (%L, %L)', :CHAT, :ANN)),
  'a chat may not have two LIVE calls at once');

SET LOCAL app.current_user_id = :BOB;
SELECT pg_temp.ck((SELECT count(*) FROM calls WHERE id = :CALL) = 1, 'a member sees the call');
SET LOCAL app.current_user_id = :EVE;
SELECT pg_temp.ck((SELECT count(*) FROM calls WHERE id = :CALL) = 0, 'a non-member does NOT see the call');

-- ── participants and roles ──
SET LOCAL app.current_user_id = :ANN;
INSERT INTO call_participants (call_id, user_id, role) VALUES (:CALL, :ANN, 'host');
SET LOCAL app.current_user_id = :BOB;
INSERT INTO call_participants (call_id, user_id, role) VALUES (:CALL, :BOB, 'audience');
SELECT pg_temp.ck(TRUE, 'members may join a call as themselves');

SELECT pg_temp.ck(
  pg_temp.refused(:EVE, format('INSERT INTO call_participants (call_id, user_id) VALUES (%L, %L)', :CALL, :EVE)),
  'a non-member may not join');
SELECT pg_temp.ck(
  pg_temp.refused(:BOB, format('INSERT INTO call_participants (call_id, user_id) VALUES (%L, %L)', :CALL, :EVE)),
  'a participant may not add someone else');

-- The escalation that matters: an audience member reaching for a publish grant.
SELECT pg_temp.ck(
  pg_temp.refused(:BOB, format(
    'UPDATE call_participants SET role = ''speaker'' WHERE call_id = %L AND user_id = %L', :CALL, :BOB)),
  'an audience member may NOT promote themselves');
SET LOCAL app.current_user_id = :ANN;
SELECT pg_temp.ck((SELECT role FROM call_participants WHERE call_id = :CALL AND user_id = :BOB) = 'audience',
  '  …and their role is unchanged');

SELECT pg_temp.ck(
  pg_temp.refused(:BOB, format(
    'UPDATE call_participants SET role = ''audience'' WHERE call_id = %L AND user_id = %L', :CALL, :ANN)),
  'a participant may not demote the host');

SET LOCAL app.current_user_id = :ANN;
UPDATE call_participants SET role = 'speaker' WHERE call_id = :CALL AND user_id = :BOB;
SELECT pg_temp.ck((SELECT role FROM call_participants WHERE call_id = :CALL AND user_id = :BOB) = 'speaker',
  'the host MAY promote a participant');

-- Own-row edits that are not the role column stay allowed — leaving and raising
-- a hand are things you do to yourself.
SET LOCAL app.current_user_id = :BOB;
UPDATE call_participants SET hand_raised_at = NOW() WHERE call_id = :CALL AND user_id = :BOB;
SELECT pg_temp.ck((SELECT hand_raised_at IS NOT NULL FROM call_participants WHERE call_id = :CALL AND user_id = :BOB),
  'a participant may raise their own hand');
UPDATE call_participants SET left_at = NOW() WHERE call_id = :CALL AND user_id = :BOB;
SELECT pg_temp.ck((SELECT left_at IS NOT NULL FROM call_participants WHERE call_id = :CALL AND user_id = :BOB),
  'a participant may leave');

SELECT pg_temp.ck(
  pg_temp.refused(:ANN, format(
    'UPDATE call_participants SET role = ''superuser'' WHERE call_id = %L AND user_id = %L', :CALL, :BOB)),
  'an unknown role is rejected by the check constraint');

SET LOCAL app.current_user_id = :ANN;
UPDATE calls SET ended_at = NOW(), end_reason = 'host_ended' WHERE id = :CALL;
INSERT INTO calls (chat_id, started_by) VALUES (:CHAT, :ANN);
SELECT pg_temp.ck(TRUE, 'a new call is allowed once the previous one ended');

COMMIT;

\echo 'ALL CALL RLS CHECKS PASSED'
