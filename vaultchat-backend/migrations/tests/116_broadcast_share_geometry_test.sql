-- 116_broadcast_share_geometry_test.sql — rehearses the share-shape columns.
--
-- The Go tests cover the webhook BINDING, which is pure JSON. What they cannot
-- cover is the half that only exists in Postgres: the CHECK that stops a half
-- written pair from being read as a shape, and the fact that NULL survives as
-- "no share running" rather than collapsing to a zero that a client would
-- believe. A guard that lives only in a Go if-statement is not a guard when two
-- webhook retries race.
--
-- Run against a throwaway copy of production's schema:
--   docker exec vaultchat-postgres-1 sh -c 'pg_dump -U vaultchat -s vaultchat > /tmp/s.sql'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d postgres -c 'CREATE DATABASE sgtest'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d sgtest -q -f /tmp/s.sql
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d sgtest -v ON_ERROR_STOP=1 -f <this file>
--
-- Every assertion raises, so a non-zero exit means a real failure.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name)
VALUES ('33333333-0000-4000-8000-0000000000b1', '+910000000b01', 'Share Host');

INSERT INTO broadcast_sessions (id, host_id, title, status, room)
VALUES ('44444444-0000-4000-8000-0000000000b1',
        '33333333-0000-4000-8000-0000000000b1',
        'Game Night', 'live', 'golive_44444444-0000-4000-8000-0000000000b1');

-- ── 1. no share is the default, and it is NULL, not zero ──────────
-- The client branches on absence: it turns the panel for a landscape share and
-- leaves it alone otherwise. A 0 would be a shape, and 0x0 is landscape by the
-- >= comparison that decides.
DO $$
DECLARE w INT; h INT;
BEGIN
  SELECT share_w, share_h INTO w, h FROM broadcast_sessions
   WHERE id = '44444444-0000-4000-8000-0000000000b1';
  IF w IS NOT NULL OR h IS NOT NULL THEN
    RAISE EXCEPTION 'a fresh broadcast claims a share shape: %x%', w, h;
  END IF;
END $$;

-- ── 2. the measured portrait share stores and reads back exactly ──
-- 1200x2664 is what an Honor actually published on 2026-08-25. It must survive
-- the round trip unrounded: the client divides these to get an aspect ratio and
-- compares it against the panel within a 12% budget, so a couple of pixels of
-- drift is fine but a swapped pair is a rotated phone.
UPDATE broadcast_sessions
   SET share_w = 1200, share_h = 2664
 WHERE id = '44444444-0000-4000-8000-0000000000b1';

DO $$
DECLARE w INT; h INT;
BEGIN
  SELECT share_w, share_h INTO w, h FROM broadcast_sessions
   WHERE id = '44444444-0000-4000-8000-0000000000b1';
  IF w <> 1200 OR h <> 2664 THEN
    RAISE EXCEPTION 'portrait share round-tripped as %x%, want 1200x2664', w, h;
  END IF;
  IF w >= h THEN
    RAISE EXCEPTION 'a portrait share reads as landscape — every viewer would turn their phone';
  END IF;
END $$;

-- ── 3. a landscape game stores as landscape ───────────────────────
-- The case this whole column pair exists for: PUBG shared from a phone that has
-- turned itself sideways to play it.
UPDATE broadcast_sessions
   SET share_w = 2664, share_h = 1200
 WHERE id = '44444444-0000-4000-8000-0000000000b1';

DO $$
DECLARE w INT; h INT;
BEGIN
  SELECT share_w, share_h INTO w, h FROM broadcast_sessions
   WHERE id = '44444444-0000-4000-8000-0000000000b1';
  IF w <= h THEN
    RAISE EXCEPTION 'a landscape game reads as portrait — the panel would never turn';
  END IF;
END $$;

-- ── 4. HALF a pair is refused ─────────────────────────────────────
-- This is the one the CHECK exists for. A width with no height divides to
-- nothing usable, and the client cannot tell it from a real shape without
-- knowing to look — so the database refuses to hold it at all.
DO $$
BEGIN
  BEGIN
    UPDATE broadcast_sessions SET share_w = 1200, share_h = NULL
     WHERE id = '44444444-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'a half-written pair was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL; -- correct
  END;
  BEGIN
    UPDATE broadcast_sessions SET share_w = NULL, share_h = 2664
     WHERE id = '44444444-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'a half-written pair was accepted the other way round';
  EXCEPTION WHEN check_violation THEN
    NULL; -- correct
  END;
END $$;

-- ── 5. nonsense geometry is refused ───────────────────────────────
-- Zero and negative both divide into an aspect ratio that is either infinite or
-- inverted, and either one turns a viewer's phone for no reason.
DO $$
BEGIN
  BEGIN
    UPDATE broadcast_sessions SET share_w = 0, share_h = 0
     WHERE id = '44444444-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION '0x0 was accepted as a shape';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE broadcast_sessions SET share_w = -1200, share_h = 2664
     WHERE id = '44444444-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'a negative width was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

-- ── 6. clearing BOTH is how a share ends ──────────────────────────
-- track_unpublished writes NULLs. If the CHECK rejected that, a finished share
-- would stay on the row forever and every later viewer would turn their phone
-- for a game nobody is playing.
UPDATE broadcast_sessions
   SET share_w = NULL, share_h = NULL
 WHERE id = '44444444-0000-4000-8000-0000000000b1';

DO $$
DECLARE w INT;
BEGIN
  SELECT share_w INTO w FROM broadcast_sessions
   WHERE id = '44444444-0000-4000-8000-0000000000b1';
  IF w IS NOT NULL THEN
    RAISE EXCEPTION 'a stopped share left its shape behind';
  END IF;
END $$;

-- ── 7. the webhook's own UPDATE matches by ROOM and only while live ─
-- The WHERE clause IS the authorization: an event naming a room this server did
-- not create, or one whose broadcast has ended, must change nothing.
UPDATE broadcast_sessions SET status = 'ended'
 WHERE id = '44444444-0000-4000-8000-0000000000b1';

DO $$
DECLARE n INT;
BEGIN
  WITH upd AS (
    UPDATE broadcast_sessions SET share_w = 2664, share_h = 1200
     WHERE room = 'golive_44444444-0000-4000-8000-0000000000b1'
       AND status IN ('starting', 'live')
    RETURNING 1)
  SELECT count(*) INTO n FROM upd;
  IF n <> 0 THEN
    RAISE EXCEPTION 'an ended broadcast still accepted a share shape';
  END IF;

  WITH upd AS (
    UPDATE broadcast_sessions SET share_w = 2664, share_h = 1200
     WHERE room = 'golive_not-a-room-we-made'
       AND status IN ('starting', 'live')
    RETURNING 1)
  SELECT count(*) INTO n FROM upd;
  IF n <> 0 THEN
    RAISE EXCEPTION 'an unknown room matched a row';
  END IF;
END $$;

ROLLBACK;
