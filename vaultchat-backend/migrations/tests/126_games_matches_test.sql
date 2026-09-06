-- 126_games_matches_test.sql — proves the match table enforces the two things
-- the Go handler leans on and cannot check for itself.
--
-- Five things, all of which only a database can answer:
--
--   1. the variant CHECK rejects a format the app does not implement
--   2. the status CHECK rejects anything but running/finished
--   3. ONE running match per table (the partial unique index) — this is what
--      makes "open a match" idempotent when six clients race to open it
--   4. a FINISHED match does not block a new one at the same table
--   5. the optimistic-concurrency UPDATE applies exactly once, which is the
--      whole defence against one deal being counted once per seat
--
-- Run AFTER applying 126:
--
--   docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat \
--     -v ON_ERROR_STOP=1 -f - < this file
--
-- Self-cleaning: everything happens inside a transaction that is rolled back.
\set ON_ERROR_STOP on

BEGIN;

-- ── 1. the variant CHECK ──────────────────────────────────────────
-- Asserted first: the app must never be able to store a format it has no rules
-- for, because the Go scorer would then silently apply neither pool nor deals.
DO $chk1$
BEGIN
  BEGIN
    INSERT INTO games_matches (table_id, variant, host_vault_id)
    VALUES ('t-bad', 'pool151', 'v1');
    RAISE EXCEPTION 'FAIL: an unknown variant was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok 1: unknown variant rejected';
  END;
END $chk1$;

-- ── 2. the status CHECK ───────────────────────────────────────────
DO $chk2$
BEGIN
  BEGIN
    INSERT INTO games_matches (table_id, variant, host_vault_id, status)
    VALUES ('t-bad2', 'pool101', 'v1', 'abandoned');
    RAISE EXCEPTION 'FAIL: an unknown status was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok 2: unknown status rejected';
  END;
END $chk2$;

-- ── 3. ONE running match per table ────────────────────────────────
-- The partial unique index is what makes gamesCreateMatch idempotent: every
-- client at the table may try to open the match when the host announces it, and
-- the losers must read back the winner's row instead of creating a second one.
-- Without this, six clients open six matches and each device scores a different
-- one.
INSERT INTO games_matches (id, table_id, variant, host_vault_id)
VALUES ('33333333-0000-4000-8000-0000000000a1', 't-live', 'pool101', 'v1');

DO $chk3$
BEGIN
  BEGIN
    INSERT INTO games_matches (table_id, variant, host_vault_id)
    VALUES ('t-live', 'deals6', 'v2');
    RAISE EXCEPTION 'FAIL: a second running match was allowed at one table';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 3: only one running match per table';
  END;
END $chk3$;

-- ── 4. a finished match frees the table ───────────────────────────
-- The index is PARTIAL for this reason. If it were a plain unique index, the
-- first match ever played at a table would block that table forever — and since
-- the games server publishes no game-over event, nobody would understand why.
UPDATE games_matches SET status = 'finished'
 WHERE id = '33333333-0000-4000-8000-0000000000a1';

INSERT INTO games_matches (id, table_id, variant, host_vault_id)
VALUES ('33333333-0000-4000-8000-0000000000a2', 't-live', 'deals2', 'v2');

DO $chk4$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM games_matches WHERE table_id = 't-live';
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 rows at t-live, found %', n;
  END IF;
  RAISE NOTICE 'ok 4: a finished match does not block a new one';
END $chk4$;

-- ── 5. the deal guard applies exactly once ────────────────────────
-- THE MOST IMPORTANT ONE. Every seat at the table watches the same deal end and
-- all of them post it. The handler's UPDATE is guarded on deals_played, so the
-- first writer wins and the rest match no row. If this ever stops holding, one
-- deal is counted once per player and a pool eliminates the whole table at once.
DO $chk5$
DECLARE first_n INT; second_n INT; final_deals INT;
BEGIN
  -- Client A reports deal index 0.
  WITH upd AS (
    UPDATE games_matches
       SET deals_played = 1, scores = '{"a":{"points":40,"status":"playing"}}'::JSONB
     WHERE id = '33333333-0000-4000-8000-0000000000a2'
       AND deals_played = 0 AND status = 'running'
    RETURNING 1
  ) SELECT count(*) INTO first_n FROM upd;

  -- Client B reports the SAME deal index 0, a moment later.
  WITH upd AS (
    UPDATE games_matches
       SET deals_played = 1, scores = '{"a":{"points":80,"status":"playing"}}'::JSONB
     WHERE id = '33333333-0000-4000-8000-0000000000a2'
       AND deals_played = 0 AND status = 'running'
    RETURNING 1
  ) SELECT count(*) INTO second_n FROM upd;

  SELECT deals_played INTO final_deals
    FROM games_matches WHERE id = '33333333-0000-4000-8000-0000000000a2';

  IF first_n <> 1 THEN
    RAISE EXCEPTION 'FAIL: the first report did not apply (matched % rows)', first_n;
  END IF;
  IF second_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a duplicate report applied — every score would be multiplied by the seat count';
  END IF;
  IF final_deals <> 1 THEN
    RAISE EXCEPTION 'FAIL: deals_played = %, want 1', final_deals;
  END IF;
  RAISE NOTICE 'ok 5: one deal counted exactly once, however many seats report it';
END $chk5$;

ROLLBACK;
