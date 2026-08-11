-- 085_space_links_test.sql — rehearses the scoped-visibility resolver and its
-- RLS policies against a copy of the real schema
-- (openspec: spaces-operations, S1.6 / S1.7).
--
-- This is the test for the most sensitive claim in the change: a parent sees
-- their own child and no other child. The rule lives in a recursive CTE and two
-- RLS policies — neither of which any Go unit test executes — so it is rehearsed
-- here, with a real planner, real policies and a real session user.
--
-- S1.7 in particular: it is not enough to check that the resolver returns the
-- right set. The negative case must be attempted the way an attacker would —
-- SELECT the other child's row DIRECTLY, by id, as the parent — because a UI
-- filter passes the first test and fails the second.
--
-- Everything runs in a transaction that ends in ROLLBACK; the fixtures never
-- persist.
--
-- Run against a throwaway copy of production's schema:
--   docker exec vaultchat-postgres-1 sh -c 'pg_dump -U vaultchat -s vaultchat > /tmp/s.sql'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d postgres -c 'CREATE DATABASE spacetest'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d spacetest -q -f /tmp/s.sql
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d spacetest -v ON_ERROR_STOP=1 -f <this file>
--
-- Every assertion raises, so a non-zero exit means a real failure.
\set ON_ERROR_STOP on

BEGIN;

-- ── fixtures ────────────────────────────────────────────────────────
-- A school space with: a principal (owner), a parent of child A, a parent of
-- child B, and a deep supervisory chain to exercise the depth bound.
INSERT INTO users (id, phone, name) VALUES
  ('aaaa0000-0000-4000-8000-000000000001', '+915000000001', 'Principal'),
  ('aaaa0000-0000-4000-8000-000000000002', '+915000000002', 'Parent A'),
  ('aaaa0000-0000-4000-8000-000000000003', '+915000000003', 'Parent B'),
  ('aaaa0000-0000-4000-8000-000000000004', '+915000000004', 'Deep Manager');

INSERT INTO chats (id, type, name, group_type, created_by)
VALUES ('bbbb0000-0000-4000-8000-000000000001', 'group', 'Rehearsal School',
        'school', 'aaaa0000-0000-4000-8000-000000000001');

INSERT INTO chat_members (chat_id, user_id, role) VALUES
  ('bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000001', 'owner'),
  ('bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000002', 'member'),
  ('bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000003', 'member'),
  ('bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000004', 'moderator');

-- Roster: two parents with accounts, two children WITHOUT accounts — the case a
-- users-keyed model cannot express at all.
INSERT INTO space_roster (id, chat_id, user_id, display_name, kind) VALUES
  ('cccc0000-0000-4000-8000-00000000000a', 'bbbb0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000002', 'Parent A', 'person'),
  ('cccc0000-0000-4000-8000-00000000000b', 'bbbb0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000003', 'Parent B', 'person'),
  ('cccc0000-0000-4000-8000-00000000000c', 'bbbb0000-0000-4000-8000-000000000001',
   NULL, 'Child A', 'child'),
  ('cccc0000-0000-4000-8000-00000000000d', 'bbbb0000-0000-4000-8000-000000000001',
   NULL, 'Child B', 'child');

INSERT INTO space_links (chat_id, subject_id, object_id, relation) VALUES
  ('bbbb0000-0000-4000-8000-000000000001',
   'cccc0000-0000-4000-8000-00000000000a', 'cccc0000-0000-4000-8000-00000000000c', 'guardian_of'),
  ('bbbb0000-0000-4000-8000-000000000001',
   'cccc0000-0000-4000-8000-00000000000b', 'cccc0000-0000-4000-8000-00000000000d', 'guardian_of');

-- ── the resolver, as pure data ──────────────────────────────────────
DO $$
DECLARE n INT;
BEGIN
  -- Parent A sees themselves and Child A. Two rows, no more.
  SELECT COUNT(*) INTO n FROM space_visible_roster(
    'bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000002');
  IF n <> 2 THEN RAISE EXCEPTION 'Parent A resolved % entries, expected 2 (self + own child)', n; END IF;

  -- and specifically NOT Child B
  SELECT COUNT(*) INTO n FROM space_visible_roster(
    'bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000002')
   WHERE roster_id = 'cccc0000-0000-4000-8000-00000000000d';
  IF n <> 0 THEN RAISE EXCEPTION 'Parent A can resolve Child B'; END IF;

  -- A viewer with no roster entry resolves nothing — fail closed, not open.
  SELECT COUNT(*) INTO n FROM space_visible_roster(
    'bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000001');
  IF n <> 0 THEN RAISE EXCEPTION 'a viewer with no roster entry resolved % rows', n; END IF;
  RAISE NOTICE 'resolver scope OK';
END $$;

-- ── transitivity and the depth bound ────────────────────────────────
-- An eight-deep supervisory chain: the walk must stop at 6 and SAY it stopped.
-- A silently truncated org chart is the failure mode this flag exists for.
DO $$
DECLARE
  i     INT;
  prev  UUID;
  cur   UUID;
  n     INT;
  trunc BOOLEAN;
BEGIN
  prev := gen_random_uuid();
  INSERT INTO space_roster (id, chat_id, user_id, display_name, kind)
  VALUES (prev, 'bbbb0000-0000-4000-8000-000000000001',
          'aaaa0000-0000-4000-8000-000000000004', 'Deep Manager', 'person');

  FOR i IN 1..8 LOOP
    cur := gen_random_uuid();
    INSERT INTO space_roster (id, chat_id, display_name, kind)
    VALUES (cur, 'bbbb0000-0000-4000-8000-000000000001', 'Report ' || i, 'person');
    INSERT INTO space_links (chat_id, subject_id, object_id, relation)
    VALUES ('bbbb0000-0000-4000-8000-000000000001', prev, cur, 'supervises');
    prev := cur;
  END LOOP;

  -- self + 6 levels = 7 rows at the default bound
  SELECT COUNT(*) INTO n FROM space_visible_roster(
    'bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000004');
  IF n <> 7 THEN RAISE EXCEPTION 'depth-bounded walk returned % rows, expected 7', n; END IF;

  SELECT bool_or(truncated) INTO trunc FROM space_visible_roster(
    'bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000004');
  IF NOT trunc THEN RAISE EXCEPTION 'walk hit the bound but did not report truncation'; END IF;

  -- A shallower bound still terminates and still reports honestly.
  SELECT COUNT(*) INTO n FROM space_visible_roster(
    'bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000004', 2);
  IF n <> 3 THEN RAISE EXCEPTION 'depth-2 walk returned % rows, expected 3', n; END IF;
  RAISE NOTICE 'transitivity + depth bound OK';
END $$;

-- ── a cycle must not hang ───────────────────────────────────────────
-- The depth bound is the cycle guard; there is no CYCLE clause. If that
-- reasoning is ever wrong, this block never returns, which is a louder failure
-- than a wrong row count.
DO $$
DECLARE n INT;
BEGIN
  INSERT INTO space_links (chat_id, subject_id, object_id, relation) VALUES
    ('bbbb0000-0000-4000-8000-000000000001',
     'cccc0000-0000-4000-8000-00000000000c', 'cccc0000-0000-4000-8000-00000000000a', 'supervises');
  SELECT COUNT(*) INTO n FROM space_visible_roster(
    'bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000002');
  IF n < 2 THEN RAISE EXCEPTION 'cycle broke the walk (% rows)', n; END IF;
  DELETE FROM space_links
   WHERE subject_id = 'cccc0000-0000-4000-8000-00000000000c'
     AND object_id  = 'cccc0000-0000-4000-8000-00000000000a';
  RAISE NOTICE 'cycle terminates OK';
END $$;

-- ── archived entries drop out of every live view ────────────────────
DO $$
DECLARE n INT;
BEGIN
  UPDATE space_roster SET archived_at = NOW()
   WHERE id = 'cccc0000-0000-4000-8000-00000000000c';
  SELECT COUNT(*) INTO n FROM space_visible_roster(
    'bbbb0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000002');
  IF n <> 1 THEN RAISE EXCEPTION 'archived child still resolves (% rows)', n; END IF;
  UPDATE space_roster SET archived_at = NULL
   WHERE id = 'cccc0000-0000-4000-8000-00000000000c';
  RAISE NOTICE 'archive OK';
END $$;

-- ── the route-level predicate, with RLS BYPASSED ────────────────────
-- This block runs as the connected role WITHOUT switching to an unprivileged
-- one — i.e. as a superuser, which is what the API actually connects as in the
-- current deployment (DB_USER=vaultchat, rolsuper=t). Superusers bypass RLS
-- unconditionally, so the policies below are inert on that connection and the
-- WHERE clauses in internal/routes/spaces_roster.go are the only thing scoping
-- the roster.
--
-- Verified on production 2026-08-11: a bare `SELECT ... WHERE chat_id = $1`
-- returned 2 of 2 rows to a parent. The predicate must return 1.
--
-- If the API is ever moved to a non-superuser role, this block keeps passing —
-- it just stops being the only thing that does.
DO $$
DECLARE n INT; sup BOOLEAN;
BEGIN
  SELECT rolsuper INTO sup FROM pg_roles WHERE rolname = current_user;
  PERFORM set_config('app.current_user_id', 'aaaa0000-0000-4000-8000-000000000002', TRUE);

  -- what the route actually runs
  SELECT COUNT(*) INTO n FROM space_roster
   WHERE chat_id = 'bbbb0000-0000-4000-8000-000000000001'
     AND archived_at IS NULL
     AND (vc_space_ops_viewer('bbbb0000-0000-4000-8000-000000000001')
          OR space_can_view_roster('bbbb0000-0000-4000-8000-000000000001',
                                   'aaaa0000-0000-4000-8000-000000000002', id));
  IF n <> 2 THEN
    RAISE EXCEPTION 'route predicate returned % rows for Parent A, expected 2 (self + own child)', n;
  END IF;

  -- and specifically not the other child
  SELECT COUNT(*) INTO n FROM space_roster
   WHERE chat_id = 'bbbb0000-0000-4000-8000-000000000001'
     AND id = 'cccc0000-0000-4000-8000-00000000000d'
     AND (vc_space_ops_viewer('bbbb0000-0000-4000-8000-000000000001')
          OR space_can_view_roster('bbbb0000-0000-4000-8000-000000000001',
                                   'aaaa0000-0000-4000-8000-000000000002', id));
  IF n <> 0 THEN RAISE EXCEPTION 'route predicate leaked Child B'; END IF;

  -- the ops bypass still works through the same predicate
  PERFORM set_config('app.current_user_id', 'aaaa0000-0000-4000-8000-000000000001', TRUE);
  SELECT COUNT(*) INTO n FROM space_roster
   WHERE chat_id = 'bbbb0000-0000-4000-8000-000000000001'
     AND archived_at IS NULL
     AND (vc_space_ops_viewer('bbbb0000-0000-4000-8000-000000000001')
          OR space_can_view_roster('bbbb0000-0000-4000-8000-000000000001',
                                   'aaaa0000-0000-4000-8000-000000000001', id));
  IF n < 4 THEN RAISE EXCEPTION 'route predicate hid the roster from ops (% rows)', n; END IF;

  IF sup THEN
    RAISE NOTICE 'route predicate OK — and it is doing the work, this session bypasses RLS';
  ELSE
    RAISE NOTICE 'route predicate OK (session is not a superuser; RLS also applies)';
  END IF;
END $$;

-- ── S1.7: the attack, not the happy path ────────────────────────────
-- Everything above tested the resolver as a function. This tests the POLICY, as
-- the parent's own session, reading the other child's row directly by id — the
-- request a modified client makes. A UI-only filter passes every test above and
-- fails this one.
--
-- A NON-SUPERUSER role is mandatory here. psql runs as the database owner, and
-- a superuser bypasses RLS entirely — so without this the policy assertions
-- would be measured against a session no policy applies to. (They would fail
-- rather than pass falsely, since the counts would come back too high, but a
-- test that fails for the wrong reason is not a test.) Role DDL is
-- transactional, so the ROLLBACK removes it.
CREATE ROLE vc_rls_rehearsal NOLOGIN;
GRANT USAGE ON SCHEMA public TO vc_rls_rehearsal;
GRANT SELECT, INSERT, UPDATE, DELETE ON space_roster, space_links, chat_members, chats
  TO vc_rls_rehearsal;
SET LOCAL ROLE vc_rls_rehearsal;

DO $$
DECLARE n INT;
BEGIN
  PERFORM set_config('app.current_user_id', 'aaaa0000-0000-4000-8000-000000000002', TRUE);

  -- the whole roster, as Parent A: self + own child only
  SELECT COUNT(*) INTO n FROM space_roster
   WHERE chat_id = 'bbbb0000-0000-4000-8000-000000000001';
  IF n <> 2 THEN RAISE EXCEPTION 'RLS let Parent A see % roster rows, expected 2', n; END IF;

  -- the direct hit: name the other child's id explicitly
  SELECT COUNT(*) INTO n FROM space_roster
   WHERE id = 'cccc0000-0000-4000-8000-00000000000d';
  IF n <> 0 THEN RAISE EXCEPTION 'RLS let Parent A read Child B by id'; END IF;

  -- links: visible from the subject end only. Parent A must not be able to
  -- enumerate who else guards whom.
  SELECT COUNT(*) INTO n FROM space_links
   WHERE chat_id = 'bbbb0000-0000-4000-8000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'RLS let Parent A see % links, expected 1', n; END IF;

  -- and cannot write the roster: reading is scoped, writing is ops-only
  BEGIN
    INSERT INTO space_roster (chat_id, display_name, kind)
    VALUES ('bbbb0000-0000-4000-8000-000000000001', 'Smuggled Child', 'child');
    RAISE EXCEPTION 'RLS let a parent insert a roster entry';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    NULL; -- expected
  END;
  RAISE NOTICE 'parent scope enforced by RLS (direct read refused)';
END $$;

-- ── the ops view, same session mechanism ────────────────────────────
DO $$
DECLARE n INT;
BEGIN
  -- The principal is owner rank and holds the space-wide view, with no links at
  -- all. This is the bypass working as designed.
  PERFORM set_config('app.current_user_id', 'aaaa0000-0000-4000-8000-000000000001', TRUE);
  SELECT COUNT(*) INTO n FROM space_roster
   WHERE chat_id = 'bbbb0000-0000-4000-8000-000000000001';
  IF n < 4 THEN RAISE EXCEPTION 'ops view saw only % roster rows', n; END IF;

  -- A non-member sees nothing, links or roster, whatever their rank elsewhere.
  PERFORM set_config('app.current_user_id', 'aaaa0000-0000-4000-8000-000000000009', TRUE);
  SELECT COUNT(*) INTO n FROM space_roster
   WHERE chat_id = 'bbbb0000-0000-4000-8000-000000000001';
  IF n <> 0 THEN RAISE EXCEPTION 'a non-member saw % roster rows', n; END IF;
  RAISE NOTICE 'ops bypass + non-member denial OK';
END $$;

RESET ROLE;
ROLLBACK;
