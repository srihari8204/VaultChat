-- 121_run_delay_threshold_test.sql — rehearses the overdue-stop predicate the
-- Go delay evaluator runs on every driver heartbeat (spaces_runs.go
-- runCheckDelays). The predicate is copied verbatim from there; if the two
-- drift, this file tests a statement that no longer runs — keep them identical.
--
-- Why paranoid: the evaluator notifies GUARDIANS. A predicate that matches too
-- much spams every parent on every ping; the dedup (one run_events row per
-- overdue stop) is the only thing standing between one heartbeat every few
-- seconds and one push every few seconds.
--
-- Run against a throwaway copy of production's schema:
--   docker exec vaultchat-postgres-1 sh -c 'pg_dump -U vaultchat -s vaultchat > /tmp/s.sql'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d postgres -c 'CREATE DATABASE rdtest'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d rdtest -q -f /tmp/s.sql
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d rdtest -v ON_ERROR_STOP=1 -f <this file>
--
-- Every assertion raises, so a non-zero exit means a real failure.

BEGIN;

DO $$
DECLARE
  v_chat  UUID := gen_random_uuid();
  v_user  UUID := gen_random_uuid();
  v_run   UUID := gen_random_uuid();
  v_late  UUID := gen_random_uuid();   -- planned 30 min ago, never reached  → matches
  v_ok    UUID := gen_random_uuid();   -- planned 30 min ago, REACHED        → must not match
  v_soon  UUID := gen_random_uuid();   -- planned 5 min ago (inside 10-min)  → must not match
  v_naked UUID := gen_random_uuid();   -- no planned_at at all               → must not match
  n INT;
BEGIN
  INSERT INTO users (id, phone, name) VALUES (v_user, '+910000000121', 'Delay Test');
  INSERT INTO chats (id, type, created_by) VALUES (v_chat, 'group', v_user);

  -- The column exists and defaults to the client's 10.
  SELECT run_delay_threshold_minutes INTO n FROM chats WHERE id = v_chat;
  IF n IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'default threshold: expected 10, got %', n;
  END IF;

  INSERT INTO runs (id, chat_id, kind, name, status)
  VALUES (v_run, v_chat, 'school_pickup', 'Bus 7', 'started');

  INSERT INTO run_stops (id, run_id, seq, label, lat, lng, planned_at, arrived_at) VALUES
    (v_late,  v_run, 1, 'Late stop',    0, 0, NOW() - INTERVAL '30 minutes', NULL),
    (v_ok,    v_run, 2, 'Reached stop', 0, 0, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '20 minutes'),
    (v_soon,  v_run, 3, 'Soon stop',    0, 0, NOW() - INTERVAL '5 minutes',  NULL),
    (v_naked, v_run, 4, 'No plan',      0, 0, NULL,                          NULL);

  -- ── the evaluator's predicate, verbatim from runCheckDelays ──────────
  SELECT COUNT(*) INTO n
    FROM run_stops st
    JOIN runs r ON r.id = st.run_id
   WHERE st.run_id = v_run
     AND r.status = 'started'
     AND st.arrived_at IS NULL
     AND st.planned_at IS NOT NULL
     AND st.planned_at < NOW() - make_interval(
           mins => (SELECT run_delay_threshold_minutes FROM chats WHERE id = r.chat_id))
     AND NOT EXISTS (
           SELECT 1 FROM run_events e
            WHERE e.run_id = st.run_id AND e.kind = 'run_delayed' AND e.ref_id = st.id);

  IF n <> 1 THEN
    RAISE EXCEPTION 'overdue predicate: expected exactly the late stop, got % rows', n;
  END IF;

  -- The dedup: once the run_delayed event is written, the same stop never
  -- matches again — this is what turns "a ping every few seconds" into "one
  -- notification, ever".
  INSERT INTO run_events (run_id, kind, ref_id, actor_id)
  VALUES (v_run, 'run_delayed', v_late, v_user);

  SELECT COUNT(*) INTO n
    FROM run_stops st
    JOIN runs r ON r.id = st.run_id
   WHERE st.run_id = v_run
     AND r.status = 'started'
     AND st.arrived_at IS NULL
     AND st.planned_at IS NOT NULL
     AND st.planned_at < NOW() - make_interval(
           mins => (SELECT run_delay_threshold_minutes FROM chats WHERE id = r.chat_id))
     AND NOT EXISTS (
           SELECT 1 FROM run_events e
            WHERE e.run_id = st.run_id AND e.kind = 'run_delayed' AND e.ref_id = st.id);

  IF n <> 0 THEN
    RAISE EXCEPTION 'dedup: the notified stop matched again (% rows)', n;
  END IF;

  -- A completed run stops matching entirely, whatever its stops look like.
  UPDATE runs SET status = 'completed' WHERE id = v_run;
  DELETE FROM run_events WHERE run_id = v_run AND kind = 'run_delayed';

  SELECT COUNT(*) INTO n
    FROM run_stops st
    JOIN runs r ON r.id = st.run_id
   WHERE st.run_id = v_run
     AND r.status = 'started'
     AND st.arrived_at IS NULL
     AND st.planned_at IS NOT NULL
     AND st.planned_at < NOW() - make_interval(
           mins => (SELECT run_delay_threshold_minutes FROM chats WHERE id = r.chat_id));

  IF n <> 0 THEN
    RAISE EXCEPTION 'completed run still matched % overdue stops', n;
  END IF;

  RAISE NOTICE '121_run_delay_threshold_test: OK';
END $$;

ROLLBACK;
