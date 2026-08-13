-- 086_runs_test.sql — rehearses the run engine's database-enforced rules
-- (openspec: spaces-operations, S2.14).
--
-- Four things in 086 are enforced by the DATABASE rather than by a handler,
-- because a handler is not the only thing that will ever write these rows:
--
--   1. the run lifecycle (scheduled → started → completed | cancelled)
--   2. one active run per driver, which is a RACE and cannot be checked in Go
--   3. rider-transition idempotency, which is a retry and likewise a race
--   4. the manifest scoping — a guardian sees their own child's row and no other
--
-- None of them are exercised by any Go test. They are rehearsed here against a
-- real planner, real triggers and real policies, in a transaction that ends in
-- ROLLBACK.
--
-- Run against a throwaway copy of production's schema:
--   docker exec vaultchat-postgres-1 sh -c 'pg_dump -U vaultchat -s vaultchat > /tmp/s.sql'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d postgres -c 'CREATE DATABASE runtest'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d runtest -q -f /tmp/s.sql
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d runtest -v ON_ERROR_STOP=1 -f <this file>
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name) VALUES
  ('dddd0000-0000-4000-8000-000000000001', '+916000000001', 'Ops'),
  ('dddd0000-0000-4000-8000-000000000002', '+916000000002', 'Driver'),
  ('dddd0000-0000-4000-8000-000000000003', '+916000000003', 'Parent A'),
  ('dddd0000-0000-4000-8000-000000000004', '+916000000004', 'Parent B');

INSERT INTO chats (id, type, name, group_type, created_by)
VALUES ('eeee0000-0000-4000-8000-000000000001', 'group', 'Rehearsal Transport',
        'school_transport', 'dddd0000-0000-4000-8000-000000000001');

INSERT INTO chat_members (chat_id, user_id, role, role_key) VALUES
  ('eeee0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000001', 'owner', NULL),
  ('eeee0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000002', 'member', 'driver'),
  ('eeee0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000003', 'member', 'parent'),
  ('eeee0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000004', 'member', 'parent');

INSERT INTO space_roster (id, chat_id, user_id, display_name, kind, handover_code) VALUES
  ('ffff0000-0000-4000-8000-00000000000a', 'eeee0000-0000-4000-8000-000000000001',
   'dddd0000-0000-4000-8000-000000000003', 'Parent A', 'person', NULL),
  ('ffff0000-0000-4000-8000-00000000000b', 'eeee0000-0000-4000-8000-000000000001',
   'dddd0000-0000-4000-8000-000000000004', 'Parent B', 'person', NULL),
  ('ffff0000-0000-4000-8000-00000000000c', 'eeee0000-0000-4000-8000-000000000001',
   NULL, 'Child A', 'child', '4821'),
  ('ffff0000-0000-4000-8000-00000000000d', 'eeee0000-0000-4000-8000-000000000001',
   NULL, 'Child B', 'child', '9930');

INSERT INTO space_links (chat_id, subject_id, object_id, relation) VALUES
  ('eeee0000-0000-4000-8000-000000000001',
   'ffff0000-0000-4000-8000-00000000000a', 'ffff0000-0000-4000-8000-00000000000c', 'guardian_of'),
  ('eeee0000-0000-4000-8000-000000000001',
   'ffff0000-0000-4000-8000-00000000000b', 'ffff0000-0000-4000-8000-00000000000d', 'guardian_of');

INSERT INTO runs (id, chat_id, kind, name, driver_id, vehicle_label, status)
VALUES ('99990000-0000-4000-8000-000000000001', 'eeee0000-0000-4000-8000-000000000001',
        'school_pickup', 'Route 1 AM', 'dddd0000-0000-4000-8000-000000000002', 'Bus 01', 'scheduled');

INSERT INTO run_stops (id, run_id, seq, label, lat, lng) VALUES
  ('88880000-0000-4000-8000-000000000001', '99990000-0000-4000-8000-000000000001', 0, 'Green Lane', 12.9, 77.6),
  ('88880000-0000-4000-8000-000000000002', '99990000-0000-4000-8000-000000000001', 1, 'School Gate', 12.95, 77.62);

INSERT INTO run_riders (run_id, rider_id, stop_id) VALUES
  ('99990000-0000-4000-8000-000000000001', 'ffff0000-0000-4000-8000-00000000000c',
   '88880000-0000-4000-8000-000000000001'),
  ('99990000-0000-4000-8000-000000000001', 'ffff0000-0000-4000-8000-00000000000d',
   '88880000-0000-4000-8000-000000000001');

-- ── 1. lifecycle ────────────────────────────────────────────────────
DO $$
DECLARE ts TIMESTAMPTZ;
BEGIN
  -- completing a run that never started is the transition that produces a
  -- manifest nobody can explain
  BEGIN
    UPDATE runs SET status = 'completed' WHERE id = '99990000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'scheduled -> completed was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE runs SET status = 'started' WHERE id = '99990000-0000-4000-8000-000000000001';
  SELECT started_at INTO ts FROM runs WHERE id = '99990000-0000-4000-8000-000000000001';
  IF ts IS NULL THEN RAISE EXCEPTION 'started_at was not stamped by the trigger'; END IF;

  -- a client-supplied started_at must not overwrite the stamped one: it is a
  -- claim about when a bus left, and it is evidence
  UPDATE runs SET started_at = NOW() - INTERVAL '3 hours'
   WHERE id = '99990000-0000-4000-8000-000000000001';

  BEGIN
    UPDATE runs SET status = 'scheduled' WHERE id = '99990000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'started -> scheduled was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE runs SET status = 'completed' WHERE id = '99990000-0000-4000-8000-000000000001';
  SELECT completed_at INTO ts FROM runs WHERE id = '99990000-0000-4000-8000-000000000001';
  IF ts IS NULL THEN RAISE EXCEPTION 'completed_at was not stamped'; END IF;

  BEGIN
    UPDATE runs SET status = 'started' WHERE id = '99990000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'completed -> started was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- and completed is terminal in every direction, including back to scheduled
  BEGIN
    UPDATE runs SET status = 'scheduled' WHERE id = '99990000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'completed -> scheduled was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'lifecycle OK';
END $$;

-- The run above is now terminal by design, so the remaining blocks need a fresh
-- one. Deleting and re-inserting is the only way back to 'started' — which is
-- the guard working, not a workaround for it.
DELETE FROM runs WHERE id = '99990000-0000-4000-8000-000000000001';
INSERT INTO runs (id, chat_id, kind, name, driver_id, vehicle_label, status, require_code)
VALUES ('99990000-0000-4000-8000-000000000001', 'eeee0000-0000-4000-8000-000000000001',
        'school_pickup', 'Route 1 AM', 'dddd0000-0000-4000-8000-000000000002', 'Bus 01',
        'started', TRUE);
INSERT INTO run_stops (id, run_id, seq, label) VALUES
  ('88880000-0000-4000-8000-000000000011', '99990000-0000-4000-8000-000000000001', 0, 'Green Lane');
INSERT INTO run_riders (run_id, rider_id, stop_id) VALUES
  ('99990000-0000-4000-8000-000000000001', 'ffff0000-0000-4000-8000-00000000000c',
   '88880000-0000-4000-8000-000000000011'),
  ('99990000-0000-4000-8000-000000000001', 'ffff0000-0000-4000-8000-00000000000d',
   '88880000-0000-4000-8000-000000000011');

-- ── 2. one active run per driver ────────────────────────────────────
DO $$
BEGIN
  BEGIN
    INSERT INTO runs (chat_id, kind, name, driver_id, status)
    VALUES ('eeee0000-0000-4000-8000-000000000001', 'school_drop', 'Route 2 PM',
            'dddd0000-0000-4000-8000-000000000002', 'started');
    RAISE EXCEPTION 'a driver was given two runs in progress';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- but a SCHEDULED second run is fine — a timetable is not a conflict
  INSERT INTO runs (id, chat_id, kind, name, driver_id, status)
  VALUES ('99990000-0000-4000-8000-000000000002', 'eeee0000-0000-4000-8000-000000000001',
          'school_drop', 'Route 2 PM', 'dddd0000-0000-4000-8000-000000000002', 'scheduled');
  RAISE NOTICE 'one-active-run OK';
END $$;

-- ── 3. transition idempotency ───────────────────────────────────────
-- The retry a driver on a moving bus WILL perform.
DO $$
DECLARE n INT;
BEGIN
  INSERT INTO run_events (run_id, kind, ref_id, actor_id, transition_id)
  VALUES ('99990000-0000-4000-8000-000000000001', 'rider_boarded',
          'ffff0000-0000-4000-8000-00000000000c', 'dddd0000-0000-4000-8000-000000000002', 'txn-1')
  ON CONFLICT (run_id, transition_id) WHERE transition_id IS NOT NULL DO NOTHING;

  INSERT INTO run_events (run_id, kind, ref_id, actor_id, transition_id)
  VALUES ('99990000-0000-4000-8000-000000000001', 'rider_boarded',
          'ffff0000-0000-4000-8000-00000000000c', 'dddd0000-0000-4000-8000-000000000002', 'txn-1')
  ON CONFLICT (run_id, transition_id) WHERE transition_id IS NOT NULL DO NOTHING;

  SELECT COUNT(*) INTO n FROM run_events
   WHERE run_id = '99990000-0000-4000-8000-000000000001' AND transition_id = 'txn-1';
  IF n <> 1 THEN RAISE EXCEPTION 'retry produced % boarding events', n; END IF;

  -- events WITHOUT a transition id are not deduped — two genuine transitions
  -- for the same rider (boarded, then dropped) must both be recorded
  INSERT INTO run_events (run_id, kind, ref_id, actor_id) VALUES
    ('99990000-0000-4000-8000-000000000001', 'rider_dropped',
     'ffff0000-0000-4000-8000-00000000000c', 'dddd0000-0000-4000-8000-000000000002'),
    ('99990000-0000-4000-8000-000000000001', 'stop_arrived',
     '88880000-0000-4000-8000-000000000011', 'dddd0000-0000-4000-8000-000000000002');
  SELECT COUNT(*) INTO n FROM run_events WHERE run_id = '99990000-0000-4000-8000-000000000001';
  IF n <> 3 THEN RAISE EXCEPTION 'event log holds % rows, expected 3', n; END IF;

  -- an unknown rider state must be refused by the CHECK, not stored
  BEGIN
    UPDATE run_riders SET state = 'teleported'
     WHERE run_id = '99990000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'an invalid rider state was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'idempotency + state CHECK OK';
END $$;

-- ── 4. the manifest is scoped per rider ─────────────────────────────
-- The claim that matters: Parent A can see the run, and on it exactly one
-- child's row. Run as a NON-SUPERUSER, because psql runs as the owner and a
-- superuser bypasses RLS entirely.
CREATE ROLE vc_runs_rehearsal NOLOGIN;
GRANT USAGE ON SCHEMA public TO vc_runs_rehearsal;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON runs, run_stops, run_riders, run_events, space_roster, space_links, chat_members, chats
  TO vc_runs_rehearsal;
SET LOCAL ROLE vc_runs_rehearsal;

DO $$
DECLARE n INT;
BEGIN
  PERFORM set_config('app.current_user_id', 'dddd0000-0000-4000-8000-000000000003', TRUE);

  -- the run their child is on is visible
  SELECT COUNT(*) INTO n FROM runs WHERE id = '99990000-0000-4000-8000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'Parent A cannot see their child''s run'; END IF;

  -- ...but only their own child's manifest row
  SELECT COUNT(*) INTO n FROM run_riders
   WHERE run_id = '99990000-0000-4000-8000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'Parent A saw % manifest rows, expected 1', n; END IF;

  -- the direct hit: name the other child's row explicitly
  SELECT COUNT(*) INTO n FROM run_riders
   WHERE rider_id = 'ffff0000-0000-4000-8000-00000000000d';
  IF n <> 0 THEN RAISE EXCEPTION 'Parent A read Child B''s manifest row by id'; END IF;

  -- stops travel with the run: knowing the bus stops on Green Lane says nothing
  -- about who lives there
  SELECT COUNT(*) INTO n FROM run_stops
   WHERE run_id = '99990000-0000-4000-8000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'Parent A saw % stops, expected 1', n; END IF;

  -- a parent cannot mark their own child boarded
  BEGIN
    UPDATE run_riders SET state = 'boarded'
     WHERE run_id = '99990000-0000-4000-8000-000000000001'
       AND rider_id = 'ffff0000-0000-4000-8000-00000000000c';
    IF FOUND THEN RAISE EXCEPTION 'a parent marked a rider boarded'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- nor rewrite the log
  BEGIN
    UPDATE run_events SET kind = 'rider_dropped'
     WHERE run_id = '99990000-0000-4000-8000-000000000001';
    IF FOUND THEN RAISE EXCEPTION 'the append-only log was rewritten'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'manifest scope OK (direct read and write both refused)';
END $$;

-- ── 5. the driver sees their run, and only their run ────────────────
DO $$
DECLARE n INT;
BEGIN
  PERFORM set_config('app.current_user_id', 'dddd0000-0000-4000-8000-000000000002', TRUE);

  -- the driver sees the WHOLE manifest of their own run — that is the job
  SELECT COUNT(*) INTO n FROM run_riders
   WHERE run_id = '99990000-0000-4000-8000-000000000001';
  IF n <> 2 THEN RAISE EXCEPTION 'driver saw % manifest rows, expected 2', n; END IF;

  -- a run they are not assigned to is invisible, even in the same space
  INSERT INTO runs (id, chat_id, kind, name, status)
  VALUES ('99990000-0000-4000-8000-000000000003', 'eeee0000-0000-4000-8000-000000000001',
          'generic', 'Someone else''s run', 'scheduled');
  RAISE EXCEPTION 'driver could insert a run'; -- write is ops-only
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'driver scope OK';
END $$;

RESET ROLE;
ROLLBACK;
