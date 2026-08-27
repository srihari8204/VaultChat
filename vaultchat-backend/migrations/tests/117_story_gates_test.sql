-- 117_story_gates_test.sql — rehearses the gate CHECK constraints.
--
-- The client decides WHICH gate to apply; only Postgres can stop a HALF-WRITTEN
-- one from being stored. That distinction matters more here than usual: a
-- 'question' row saved without its salt cannot be unwrapped by anybody,
-- including its own author, and nothing about it looks broken until a viewer
-- taps it and the decryption silently returns null. A guard that lives only in
-- a Go if-statement is not a guard when a retry races or a future caller
-- forgets a field.
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
VALUES ('00000000-0000-0000-0000-000000008117'::uuid, '+915550117', 'Gate Test')
ON CONFLICT DO NOTHING;

-- ── An ordinary status still works ───────────────────────────────────
DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'plain');
  -- every pre-existing row looks exactly like this, so if this fails the
  -- migration has broken the whole feature rather than extended it
END $$;

-- ── A well-formed puzzle gate ────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_kind, gate_grid)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'p', 'puzzle', 3);
  INSERT INTO stories (user_id, media_type, text_content, gate_kind, gate_grid)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'p', 'puzzle', 9);
END $$;

-- ── A well-formed question gate ──────────────────────────────────────
DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_kind, gate_prompt, gate_salt)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'q',
          'question', 'Where did we meet?', 'deadbeef');
END $$;

-- ── The grid range must match lib/status/gate.ts (3..9) ──────────────
DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_kind, gate_grid)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'x', 'puzzle', 2);
  RAISE EXCEPTION 'a 2x2 grid was accepted — the DB range drifted from gate.ts';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_kind, gate_grid)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'x', 'puzzle', 10);
  RAISE EXCEPTION 'a 10x10 grid was accepted — the DB range drifted from gate.ts';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- ── THE ONE THAT MATTERS: a question with no salt ────────────────────
-- Nobody could ever open this row, including its author, and it would look
-- perfectly healthy until a viewer answered correctly and still saw nothing.
DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_kind, gate_prompt)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'x',
          'question', 'no salt?');
  RAISE EXCEPTION 'a question gate without a salt was accepted — unopenable forever';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_kind, gate_prompt, gate_salt)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'x',
          'question', '', 'deadbeef');
  RAISE EXCEPTION 'an empty prompt was accepted — a question with nothing to ask';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- ── A puzzle must not carry question fields, or vice versa ───────────
DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_kind, gate_grid, gate_salt)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'x', 'puzzle', 4, 'deadbeef');
  RAISE EXCEPTION 'a puzzle carrying a salt was accepted — two gates in one row';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_kind, gate_grid, gate_prompt, gate_salt)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'x',
          'question', 5, 'q?', 'deadbeef');
  RAISE EXCEPTION 'a question carrying a grid was accepted — two gates in one row';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- ── A puzzle with no grid is not a puzzle ────────────────────────────
DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_kind)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'x', 'puzzle');
  RAISE EXCEPTION 'a puzzle without a grid was accepted — nothing to render';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- ── An unknown gate kind is refused ──────────────────────────────────
DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_kind, gate_grid)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'x', 'captcha', 3);
  RAISE EXCEPTION 'an unknown gate_kind was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- ── Gate fields without a kind are refused ───────────────────────────
-- Otherwise a client that sets a grid but forgets the kind produces a row that
-- reads as ungated and silently publishes what was meant to be locked.
DO $$
BEGIN
  INSERT INTO stories (user_id, media_type, text_content, gate_grid)
  VALUES ('00000000-0000-0000-0000-000000008117'::uuid, 'text', 'x', 4);
  RAISE EXCEPTION 'gate fields without a gate_kind were accepted — silently ungated';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

ROLLBACK;
