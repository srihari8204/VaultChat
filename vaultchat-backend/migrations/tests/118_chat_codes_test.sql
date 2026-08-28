-- 118_chat_codes_test.sql — rehearses the two partial unique indexes and the
-- CHECKs that make six digits safe enough to use.
--
-- At this entropy the schema is not bookkeeping, it is the defence:
--
--   * chat_codes_live_code_idx is what stops one guess being tested against
--     every live code at once. Without it, six digits is a lottery an attacker
--     buys a ticket to every time anyone anywhere generates a code.
--   * chat_codes_active_idx is the whole of "generating replaces". Someone left
--     holding two live codes cannot tell which one they read out.
--   * The sweep is what keeps both honest, because an EXPIRED row is still
--     un-revoked and unused, and therefore still "live" to a partial index.
--     The last block below is that failure mode written down.
--
-- Run against a throwaway copy of production's schema:
--   docker exec vaultchat-postgres-1 sh -c 'pg_dump -U vaultchat -s vaultchat > /tmp/s.sql'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d postgres -c 'CREATE DATABASE cctest'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d cctest -q -f /tmp/s.sql
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d cctest -v ON_ERROR_STOP=1 -f <this file>
--
-- Every assertion raises, so a non-zero exit means a real failure.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name)
VALUES ('00000000-0000-0000-0000-000000008118'::uuid, '+915550118', 'Code Test'),
       ('00000000-0000-0000-0000-000000008119'::uuid, '+915550119', 'Code Guest')
ON CONFLICT DO NOTHING;

-- ── One live code is fine ────────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, expires_at)
  VALUES ('00000000-0000-0000-0000-000000008118'::uuid, '004271', 3600, now() + interval '2 minutes');
END $$;

-- ── Leading zeros survive. '004271' must not become 4271 ─────────────
DO $$
DECLARE got TEXT;
BEGIN
  SELECT code INTO got FROM chat_codes WHERE owner_id = '00000000-0000-0000-0000-000000008118'::uuid;
  IF got <> '004271' THEN
    RAISE EXCEPTION 'code came back as %, not 004271 — leading zeros were lost', got;
  END IF;
END $$;

-- ── A SECOND live code for the same person must not be ───────────────
DO $$
BEGIN
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, expires_at)
  VALUES ('00000000-0000-0000-0000-000000008118'::uuid, '112233', NULL, now() + interval '2 minutes');
  RAISE EXCEPTION 'two live codes for one owner were accepted — chat_codes_active_idx is missing';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

-- ── TWO PEOPLE MUST NOT HOLD THE SAME SIX DIGITS AT ONCE ─────────────
-- The one that matters most. If this passes, a single guess is a shot at every
-- live code simultaneously and the arithmetic stops working.
DO $$
BEGIN
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, expires_at)
  VALUES ('00000000-0000-0000-0000-000000008119'::uuid, '004271', NULL, now() + interval '2 minutes');
  RAISE EXCEPTION 'the same six digits went live for two owners — chat_codes_live_code_idx is missing';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

-- ── Revoking frees both slots, which is what "New code" does ─────────
DO $$
BEGIN
  UPDATE chat_codes SET revoked_at = now()
   WHERE owner_id = '00000000-0000-0000-0000-000000008118'::uuid AND revoked_at IS NULL;
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, expires_at)
  VALUES ('00000000-0000-0000-0000-000000008118'::uuid, '004271', 10800, now() + interval '2 minutes');
END $$;

-- ── So does spending it ──────────────────────────────────────────────
DO $$
BEGIN
  UPDATE chat_codes
     SET used_by = '00000000-0000-0000-0000-000000008119'::uuid, used_at = now()
   WHERE owner_id = '00000000-0000-0000-0000-000000008118'::uuid AND used_at IS NULL;
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, keep_contact, expires_at)
  VALUES ('00000000-0000-0000-0000-000000008118'::uuid, '004271', NULL, TRUE, now() + interval '2 minutes');
END $$;

-- ── EXPIRY ALONE FREES NOTHING — the sweep is not optional ───────────
-- An expired row is still un-revoked and unused, so it still occupies its six
-- digits. This block asserts that, because it is the reason chatCodeSweep runs
-- before every mint. If this ever starts passing without a sweep, someone has
-- put now() into an index predicate and it is not doing what they think.
-- The ageing is a BARE statement, deliberately. A DO block with an EXCEPTION
-- handler is a subtransaction: catching the violation below rolls the block
-- back to its start, which would silently undo this UPDATE and leave the next
-- assertion testing nothing. Setup that must survive a caught exception goes
-- outside the block.
UPDATE chat_codes SET expires_at = now() - interval '1 minute'
 WHERE owner_id = '00000000-0000-0000-0000-000000008118'::uuid
   AND revoked_at IS NULL AND used_at IS NULL;

DO $$
BEGIN
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, expires_at)
  VALUES ('00000000-0000-0000-0000-000000008119'::uuid, '004271', NULL, now() + interval '2 minutes');
  RAISE EXCEPTION 'an expired row stopped blocking its digits on its own — the sweep would be dead code';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

-- ── ...and the sweep is what actually frees them ─────────────────────
DO $$
BEGIN
  UPDATE chat_codes SET revoked_at = now()
   WHERE revoked_at IS NULL AND used_at IS NULL AND expires_at <= now();
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, expires_at)
  VALUES ('00000000-0000-0000-0000-000000008119'::uuid, '004271', NULL, now() + interval '2 minutes');
END $$;

-- ── A code is exactly six digits ─────────────────────────────────────
DO $$
BEGIN
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, expires_at)
  VALUES ('00000000-0000-0000-0000-000000008118'::uuid, '12345', NULL, now() + interval '2 minutes');
  RAISE EXCEPTION 'a five-digit code was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

DO $$
BEGIN
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, expires_at)
  VALUES ('00000000-0000-0000-0000-000000008118'::uuid, '12345A', NULL, now() + interval '2 minutes');
  RAISE EXCEPTION 'a non-digit code was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- ── used_by and used_at are set together or not at all ───────────────
-- A half-spent row is the one state the burn-before-opening race cannot
-- tolerate: the SELECT in chatCodeJoin filters on used_at, so a row with a
-- used_by and a NULL used_at would be redeemable a second time by someone else.
DO $$
BEGIN
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, expires_at, used_by)
  VALUES ('00000000-0000-0000-0000-000000008118'::uuid, '998877', NULL, now() + interval '2 minutes',
          '00000000-0000-0000-0000-000000008119'::uuid);
  RAISE EXCEPTION 'used_by without used_at was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- ── A zero or negative timer is not a timer ──────────────────────────
-- 0 means "no timer" everywhere in the API and must arrive here as NULL;
-- storing it as 0 would set chats.disappearing_seconds = 0 on redeem, which
-- reads as "expire immediately" rather than "keep until deleted".
DO $$
BEGIN
  INSERT INTO chat_codes (owner_id, code, ttl_seconds, expires_at)
  VALUES ('00000000-0000-0000-0000-000000008118'::uuid, '887766', 0, now() + interval '2 minutes');
  RAISE EXCEPTION 'ttl_seconds = 0 was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

ROLLBACK;
