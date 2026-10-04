-- 146_incident_client_key_test.sql — rehearses the SOS idempotent insert that
-- spaces_ops.go incidentCreate runs. The INSERT and the duplicate SELECT are
-- copied verbatim from there; if the two drift, this file tests a statement
-- that no longer runs — keep them identical.
--
-- Run AFTER applying 146, against a throwaway copy of production's schema:
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d <scratch> -v ON_ERROR_STOP=1 -f <this file>
--
-- Every assertion raises, so a non-zero exit means a real failure.
-- Self-cleaning: everything happens inside a transaction that is rolled back.
\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_chat  UUID := gen_random_uuid();
  v_user  UUID := gen_random_uuid();
  v_other UUID := gen_random_uuid();
  v_run   UUID := gen_random_uuid();
  v_key   TEXT := '0f9a3c1e-7d2b-4c55-9a10-3e2f1b6d8c42';
  id1 UUID; id2 UUID; n INT;
BEGIN
  INSERT INTO users (id, phone, name) VALUES
    (v_user,  '+910000000146', 'Driver 146'),
    (v_other, '+910000000147', 'Driver 147');
  INSERT INTO chats (id, type, created_by) VALUES (v_chat, 'group', v_user);
  INSERT INTO runs (id, chat_id, kind, name, status) VALUES (v_run, v_chat, 'school_pickup', 'Bus 146', 'started');

  -- 1. first press: filed, with its press time
  INSERT INTO space_incidents
         (chat_id, run_id, reporter_id, category, note, media_ref, client_key, pressed_at)
  VALUES (v_chat, v_run, v_user, 'sos', NULLIF('', ''), NULL, NULLIF(v_key, ''), NOW() - INTERVAL '26 minutes')
  ON CONFLICT (chat_id, reporter_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
  RETURNING id INTO id1;
  IF id1 IS NULL THEN RAISE EXCEPTION 'first press was not filed'; END IF;

  -- 2. the same key again (lost answer, retried): nothing inserted ...
  INSERT INTO space_incidents
         (chat_id, run_id, reporter_id, category, note, media_ref, client_key, pressed_at)
  VALUES (v_chat, v_run, v_user, 'sos', NULLIF('', ''), NULL, NULLIF(v_key, ''), NOW())
  ON CONFLICT (chat_id, reporter_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
  RETURNING id INTO id2;
  IF id2 IS NOT NULL THEN RAISE EXCEPTION 'a repeated key filed a second incident'; END IF;
  -- ... and the duplicate lookup answers the first id
  SELECT id INTO id2 FROM space_incidents WHERE chat_id = v_chat AND reporter_id = v_user AND client_key = v_key;
  IF id2 IS DISTINCT FROM id1 THEN RAISE EXCEPTION 'duplicate lookup: expected %, got %', id1, id2; END IF;

  -- 3. no key (every older client): never deduped
  INSERT INTO space_incidents (chat_id, run_id, reporter_id, category, note, media_ref, client_key, pressed_at)
  VALUES (v_chat, v_run, v_user, 'sos', NULL, NULL, NULLIF('', ''), NULL),
         (v_chat, v_run, v_user, 'sos', NULL, NULL, NULLIF('', ''), NULL);

  -- 4. the same key from another driver is a different alert
  INSERT INTO space_incidents (chat_id, run_id, reporter_id, category, client_key)
  VALUES (v_chat, v_run, v_other, 'sos', v_key);

  SELECT COUNT(*) INTO n FROM space_incidents WHERE chat_id = v_chat;
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 incidents, got %', n; END IF;

  -- 5. a key that is not client-shaped is refused by the table too
  BEGIN
    INSERT INTO space_incidents (chat_id, reporter_id, category, client_key) VALUES (v_chat, v_user, 'sos', 'short');
    RAISE EXCEPTION 'a 5-character key was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE '146 incident client key: OK';
END $$;

ROLLBACK;
