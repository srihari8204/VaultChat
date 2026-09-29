-- 139_service_roles_test.sql — proves the service roles are isolated and the
-- membership view is live.
--
--   1. a service role can use its own tables
--   2. it cannot read another service's table
--   3. it cannot read users or chat_members directly
--   4. Family Space and Calls can read chat_membership; Go Live cannot
--   5. the view drops a member the moment they leave
--   6. no service role can write through the view
--
-- Run AFTER applying 139, as the migrating superuser (SET ROLE needs it):
--
--   docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat \
--     -v ON_ERROR_STOP=1 -f - < this file
--
-- Self-cleaning: everything happens inside a transaction that is rolled back.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name) VALUES
  ('aaaa1390-0000-4000-8000-000000000001', '+915139000001', 'Owner'),
  ('aaaa1390-0000-4000-8000-000000000002', '+915139000002', 'Leaver');
INSERT INTO chats (id, type, name, group_type, created_by)
VALUES ('bbbb1390-0000-4000-8000-000000000001', 'group', 'Family 139',
        'family', 'aaaa1390-0000-4000-8000-000000000001');
INSERT INTO chat_members (chat_id, user_id, role) VALUES
  ('bbbb1390-0000-4000-8000-000000000001', 'aaaa1390-0000-4000-8000-000000000001', 'owner'),
  ('bbbb1390-0000-4000-8000-000000000001', 'aaaa1390-0000-4000-8000-000000000002', 'member');

-- ── 1. own tables ─────────────────────────────────────────────────
SET ROLE svc_golive;
SELECT count(*) FROM broadcast_sessions;
RESET ROLE;
SET ROLE svc_shopbook;
SELECT count(*) FROM shopbook_order;
RESET ROLE;
SET ROLE svc_family;
SELECT count(*) FROM space_locations;
RESET ROLE;
\echo ok 1: each role reads its own tables

-- ── 2 and 3. nothing else ─────────────────────────────────────────
DO $chk23$
DECLARE
  probe TEXT;
BEGIN
  FOREACH probe IN ARRAY ARRAY[
    'svc_golive:shopbook_order', 'svc_shopbook:broadcast_sessions',
    'svc_games:calls', 'svc_calls:space_locations', 'svc_maps:runs',
    'svc_family:users', 'svc_family:chat_members', 'svc_golive:users'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', split_part(probe, ':', 1));
    BEGIN
      EXECUTE format('SELECT 1 FROM %I LIMIT 1', split_part(probe, ':', 2));
      RAISE EXCEPTION 'FAIL: % could read %', split_part(probe, ':', 1), split_part(probe, ':', 2);
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    RESET ROLE;
  END LOOP;
  RAISE NOTICE 'ok 2-3: no role reads another service''s table, users or chat_members';
END $chk23$;

-- ── 4. who may read the view ──────────────────────────────────────
SET ROLE svc_family;
DO $chk4a$
BEGIN
  IF (SELECT count(*) FROM chat_membership
       WHERE chat_id = 'bbbb1390-0000-4000-8000-000000000001') <> 2 THEN
    RAISE EXCEPTION 'FAIL: family does not see both members';
  END IF;
END $chk4a$;
RESET ROLE;
SET ROLE svc_calls;
SELECT count(*) FROM chat_membership;
RESET ROLE;
DO $chk4b$
BEGIN
  SET LOCAL ROLE svc_golive;
  BEGIN
    PERFORM 1 FROM chat_membership LIMIT 1;
    RAISE EXCEPTION 'FAIL: golive could read chat_membership';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END $chk4b$;
\echo ok 4: family and calls read the view, golive does not

-- ── 5. a leaver disappears at once ────────────────────────────────
UPDATE chat_members SET left_at = NOW()
 WHERE chat_id = 'bbbb1390-0000-4000-8000-000000000001'
   AND user_id = 'aaaa1390-0000-4000-8000-000000000002';
SET ROLE svc_family;
DO $chk5$
BEGIN
  IF EXISTS (SELECT 1 FROM chat_membership
              WHERE user_id = 'aaaa1390-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'FAIL: a member who left is still in chat_membership';
  END IF;
END $chk5$;
RESET ROLE;
\echo ok 5: the view drops a member who left

-- ── 6. read-only ──────────────────────────────────────────────────
DO $chk6$
BEGIN
  SET LOCAL ROLE svc_family;
  BEGIN
    UPDATE chat_membership SET role = 'owner'
     WHERE user_id = 'aaaa1390-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'FAIL: family wrote through chat_membership';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END $chk6$;
\echo ok 6: the view is read-only for services

ROLLBACK;
