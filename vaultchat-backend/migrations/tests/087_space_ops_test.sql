-- 087_space_ops_test.sql — rehearses the two ops-comms rules the database owns
-- (openspec: spaces-operations, S5.9).
--
--   1. A visitor pass redeems ONCE. The single-use guarantee is a conditional
--      UPDATE, not a read-then-write, because two gates scanning the same code
--      at the same moment is exactly what a check-then-set loses.
--   2. An incident is visible to ops, to its reporter, and to anyone who can see
--      the RUN it is on — a parent whose child is on that bus has the strongest
--      possible claim to know it has broken down. And to nobody else.
--
-- Wrapped in a transaction that ends in ROLLBACK.
--
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d spacetest -v ON_ERROR_STOP=1 -f <this file>
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name) VALUES
  ('cafe0000-0000-4000-8000-000000000001', '+917000000001', 'Ops'),
  ('cafe0000-0000-4000-8000-000000000002', '+917000000002', 'Driver'),
  ('cafe0000-0000-4000-8000-000000000003', '+917000000003', 'Parent On Run'),
  ('cafe0000-0000-4000-8000-000000000004', '+917000000004', 'Unrelated Parent');

INSERT INTO chats (id, type, name, group_type, created_by)
VALUES ('beef0000-0000-4000-8000-000000000001', 'group', 'Ops Rehearsal',
        'school_transport', 'cafe0000-0000-4000-8000-000000000001');

INSERT INTO chat_members (chat_id, user_id, role) VALUES
  ('beef0000-0000-4000-8000-000000000001', 'cafe0000-0000-4000-8000-000000000001', 'owner'),
  ('beef0000-0000-4000-8000-000000000001', 'cafe0000-0000-4000-8000-000000000002', 'member'),
  ('beef0000-0000-4000-8000-000000000001', 'cafe0000-0000-4000-8000-000000000003', 'member'),
  ('beef0000-0000-4000-8000-000000000001', 'cafe0000-0000-4000-8000-000000000004', 'member');

INSERT INTO space_roster (id, chat_id, user_id, display_name, kind) VALUES
  ('face0000-0000-4000-8000-00000000000a', 'beef0000-0000-4000-8000-000000000001',
   'cafe0000-0000-4000-8000-000000000003', 'Parent On Run', 'person'),
  ('face0000-0000-4000-8000-00000000000b', 'beef0000-0000-4000-8000-000000000001',
   'cafe0000-0000-4000-8000-000000000004', 'Unrelated Parent', 'person'),
  ('face0000-0000-4000-8000-00000000000c', 'beef0000-0000-4000-8000-000000000001',
   NULL, 'Child On Run', 'child');

INSERT INTO space_links (chat_id, subject_id, object_id, relation) VALUES
  ('beef0000-0000-4000-8000-000000000001',
   'face0000-0000-4000-8000-00000000000a', 'face0000-0000-4000-8000-00000000000c', 'guardian_of');

INSERT INTO runs (id, chat_id, kind, name, driver_id, status)
VALUES ('feed0000-0000-4000-8000-000000000001', 'beef0000-0000-4000-8000-000000000001',
        'school_pickup', 'Route 9', 'cafe0000-0000-4000-8000-000000000002', 'started');
INSERT INTO run_riders (run_id, rider_id) VALUES
  ('feed0000-0000-4000-8000-000000000001', 'face0000-0000-4000-8000-00000000000c');

INSERT INTO space_incidents (id, chat_id, run_id, reporter_id, category, note)
VALUES ('0bad0000-0000-4000-8000-000000000001', 'beef0000-0000-4000-8000-000000000001',
        'feed0000-0000-4000-8000-000000000001', 'cafe0000-0000-4000-8000-000000000002',
        'breakdown', 'ciphertext');

INSERT INTO visitor_passes (id, chat_id, host_id, visitor_name, code, valid_to)
VALUES ('900d0000-0000-4000-8000-000000000001', 'beef0000-0000-4000-8000-000000000001',
        'cafe0000-0000-4000-8000-000000000001', 'Courier', 'ABC234', NOW() + INTERVAL '2 hours');

-- ── 1. a pass redeems once ──────────────────────────────────────────
DO $$
DECLARE n INT;
BEGIN
  UPDATE visitor_passes SET redeemed_at = NOW()
   WHERE chat_id = 'beef0000-0000-4000-8000-000000000001' AND code = 'ABC234'
     AND redeemed_at IS NULL AND NOW() BETWEEN valid_from AND valid_to;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'first redeem affected % rows', n; END IF;

  -- the second gate, same code, same second
  UPDATE visitor_passes SET redeemed_at = NOW()
   WHERE chat_id = 'beef0000-0000-4000-8000-000000000001' AND code = 'ABC234'
     AND redeemed_at IS NULL AND NOW() BETWEEN valid_from AND valid_to;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'a pass was redeemed twice'; END IF;

  -- an expired pass never redeems at all
  INSERT INTO visitor_passes (chat_id, host_id, visitor_name, code, valid_from, valid_to)
  VALUES ('beef0000-0000-4000-8000-000000000001', 'cafe0000-0000-4000-8000-000000000001',
          'Late Courier', 'XYZ789', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day');
  UPDATE visitor_passes SET redeemed_at = NOW()
   WHERE chat_id = 'beef0000-0000-4000-8000-000000000001' AND code = 'XYZ789'
     AND redeemed_at IS NULL AND NOW() BETWEEN valid_from AND valid_to;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'an expired pass was redeemed'; END IF;

  -- a window that ends before it starts is not a pass
  BEGIN
    INSERT INTO visitor_passes (chat_id, visitor_name, code, valid_from, valid_to)
    VALUES ('beef0000-0000-4000-8000-000000000001', 'Time Traveller', 'QQQ111',
            NOW(), NOW() - INTERVAL '1 hour');
    RAISE EXCEPTION 'an inverted validity window was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'visitor pass single-use + window OK';
END $$;

-- ── 2. incident visibility ──────────────────────────────────────────
CREATE ROLE vc_ops_rehearsal NOLOGIN;
GRANT USAGE ON SCHEMA public TO vc_ops_rehearsal;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON space_incidents, visitor_passes, runs, run_riders, space_roster, space_links,
     chat_members, chats
  TO vc_ops_rehearsal;
SET LOCAL ROLE vc_ops_rehearsal;

DO $$
DECLARE n INT;
BEGIN
  -- the parent whose child is ON the run sees the breakdown
  PERFORM set_config('app.current_user_id', 'cafe0000-0000-4000-8000-000000000003', TRUE);
  SELECT COUNT(*) INTO n FROM space_incidents
   WHERE chat_id = 'beef0000-0000-4000-8000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'parent on the run saw % incidents, expected 1', n; END IF;

  -- and cannot close it — resolving your own breakdown report is how it vanishes
  BEGIN
    UPDATE space_incidents SET status = 'resolved'
     WHERE id = '0bad0000-0000-4000-8000-000000000001';
    IF FOUND THEN RAISE EXCEPTION 'a parent resolved an incident'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- the unrelated parent, same space, sees nothing
  PERFORM set_config('app.current_user_id', 'cafe0000-0000-4000-8000-000000000004', TRUE);
  SELECT COUNT(*) INTO n FROM space_incidents
   WHERE chat_id = 'beef0000-0000-4000-8000-000000000001';
  IF n <> 0 THEN RAISE EXCEPTION 'an unrelated member saw % incidents', n; END IF;

  -- nor the visitor pass, whose code is a credential
  SELECT COUNT(*) INTO n FROM visitor_passes
   WHERE chat_id = 'beef0000-0000-4000-8000-000000000001';
  IF n <> 0 THEN RAISE EXCEPTION 'a non-host member saw % passes', n; END IF;

  -- the driver who filed it sees their own report
  PERFORM set_config('app.current_user_id', 'cafe0000-0000-4000-8000-000000000002', TRUE);
  SELECT COUNT(*) INTO n FROM space_incidents
   WHERE chat_id = 'beef0000-0000-4000-8000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'the reporter saw % of their own incidents', n; END IF;

  -- and cannot file one AS somebody else
  BEGIN
    INSERT INTO space_incidents (chat_id, reporter_id, category)
    VALUES ('beef0000-0000-4000-8000-000000000001',
            'cafe0000-0000-4000-8000-000000000001', 'accident');
    RAISE EXCEPTION 'an incident was filed under another user';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- ops sees everything, including the pass it issued
  PERFORM set_config('app.current_user_id', 'cafe0000-0000-4000-8000-000000000001', TRUE);
  SELECT COUNT(*) INTO n FROM space_incidents
   WHERE chat_id = 'beef0000-0000-4000-8000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'ops saw % incidents', n; END IF;
  SELECT COUNT(*) INTO n FROM visitor_passes
   WHERE chat_id = 'beef0000-0000-4000-8000-000000000001';
  IF n < 2 THEN RAISE EXCEPTION 'ops saw % passes', n; END IF;
  RAISE NOTICE 'incident + pass visibility OK';
END $$;

RESET ROLE;

-- ── 3. staleness is derived, and only for a running run ─────────────
DO $$
DECLARE stale BOOLEAN;
BEGIN
  SELECT (status = 'started'
          AND (last_ping_at IS NULL OR last_ping_at < NOW() - INTERVAL '3 minutes'))
    INTO stale FROM runs WHERE id = 'feed0000-0000-4000-8000-000000000001';
  IF NOT stale THEN RAISE EXCEPTION 'a started run that never pinged is not stale'; END IF;

  UPDATE runs SET last_ping_at = NOW() WHERE id = 'feed0000-0000-4000-8000-000000000001';
  SELECT (status = 'started'
          AND (last_ping_at IS NULL OR last_ping_at < NOW() - INTERVAL '3 minutes'))
    INTO stale FROM runs WHERE id = 'feed0000-0000-4000-8000-000000000001';
  IF stale THEN RAISE EXCEPTION 'a run that just pinged is stale'; END IF;

  -- a SCHEDULED run is not stale, it is simply not out yet. Reporting tomorrow
  -- morning's bus as GPS-offline all night is how an alert becomes wallpaper.
  UPDATE runs SET status = 'cancelled' WHERE id = 'feed0000-0000-4000-8000-000000000001';
  INSERT INTO runs (id, chat_id, kind, name, status)
  VALUES ('feed0000-0000-4000-8000-000000000002', 'beef0000-0000-4000-8000-000000000001',
          'school_pickup', 'Tomorrow', 'scheduled');
  SELECT (status = 'started'
          AND (last_ping_at IS NULL OR last_ping_at < NOW() - INTERVAL '3 minutes'))
    INTO stale FROM runs WHERE id = 'feed0000-0000-4000-8000-000000000002';
  IF stale THEN RAISE EXCEPTION 'a scheduled run was reported stale'; END IF;
  RAISE NOTICE 'staleness OK';
END $$;

-- ── 4. the notification recipient set (S5.8) ────────────────────────
-- runNotifyGuardians resolves who to push to by walking space_links BACKWARDS
-- from the rider — the reverse of space_visible_roster. This is the query that
-- makes "a notification never names an unlinked rider" true, and it is not a
-- filter applied to a broadcast: there is no broadcast to filter.
--
-- Run as the connected role, because this walk runs on db.SysPool (there is no
-- acting user when a push fans out) and therefore never sees RLS.
DO $$
DECLARE n INT; who UUID;
BEGIN
  -- Child On Run has exactly one guardian, so exactly one recipient.
  SELECT COUNT(*) INTO n FROM (
    WITH RECURSIVE up AS (
      SELECT l.subject_id, 1 AS depth FROM space_links l
       WHERE l.chat_id = 'beef0000-0000-4000-8000-000000000001'
         AND l.object_id = 'face0000-0000-4000-8000-00000000000c'
      UNION
      SELECT l.subject_id, up.depth + 1 FROM up
        JOIN space_links l ON l.chat_id = 'beef0000-0000-4000-8000-000000000001'
                          AND l.object_id = up.subject_id
       WHERE up.depth < 6
    )
    SELECT DISTINCT r.user_id FROM up
      JOIN space_roster r ON r.id = up.subject_id
     WHERE r.user_id IS NOT NULL AND r.archived_at IS NULL
  ) x;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 recipient, got %', n; END IF;

  -- ...and it is the linked guardian, not the unrelated parent in the same space
  SELECT r.user_id INTO who FROM space_links l
    JOIN space_roster r ON r.id = l.subject_id
   WHERE l.chat_id = 'beef0000-0000-4000-8000-000000000001'
     AND l.object_id = 'face0000-0000-4000-8000-00000000000c';
  IF who <> 'cafe0000-0000-4000-8000-000000000003' THEN
    RAISE EXCEPTION 'wrong recipient: %', who;
  END IF;

  -- A rider nobody is linked to notifies NOBODY. Not "everyone in the space",
  -- which is what a broadcast-and-filter design degrades to when the filter is
  -- empty.
  INSERT INTO space_roster (id, chat_id, display_name, kind)
  VALUES ('face0000-0000-4000-8000-00000000000e',
          'beef0000-0000-4000-8000-000000000001', 'Unlinked Child', 'child');
  SELECT COUNT(*) INTO n FROM (
    WITH RECURSIVE up AS (
      SELECT l.subject_id, 1 AS depth FROM space_links l
       WHERE l.chat_id = 'beef0000-0000-4000-8000-000000000001'
         AND l.object_id = 'face0000-0000-4000-8000-00000000000e'
      UNION
      SELECT l.subject_id, up.depth + 1 FROM up
        JOIN space_links l ON l.chat_id = 'beef0000-0000-4000-8000-000000000001'
                          AND l.object_id = up.subject_id
       WHERE up.depth < 6
    )
    SELECT DISTINCT r.user_id FROM up JOIN space_roster r ON r.id = up.subject_id
     WHERE r.user_id IS NOT NULL
  ) x;
  IF n <> 0 THEN RAISE EXCEPTION 'an unlinked rider notified % people', n; END IF;

  -- An ARCHIVED guardian stops being notified. A parent removed from the roster
  -- must stop receiving a child''s movements immediately, not at the next
  -- deploy.
  UPDATE space_roster SET archived_at = NOW()
   WHERE id = 'face0000-0000-4000-8000-00000000000a';
  SELECT COUNT(*) INTO n FROM (
    WITH RECURSIVE up AS (
      SELECT l.subject_id, 1 AS depth FROM space_links l
       WHERE l.chat_id = 'beef0000-0000-4000-8000-000000000001'
         AND l.object_id = 'face0000-0000-4000-8000-00000000000c'
      UNION
      SELECT l.subject_id, up.depth + 1 FROM up
        JOIN space_links l ON l.chat_id = 'beef0000-0000-4000-8000-000000000001'
                          AND l.object_id = up.subject_id
       WHERE up.depth < 6
    )
    SELECT DISTINCT r.user_id FROM up JOIN space_roster r ON r.id = up.subject_id
     WHERE r.user_id IS NOT NULL AND r.archived_at IS NULL
  ) x;
  IF n <> 0 THEN RAISE EXCEPTION 'an archived guardian was still notified'; END IF;
  RAISE NOTICE 'notification recipients OK (linked only, archived excluded)';
END $$;

ROLLBACK;
