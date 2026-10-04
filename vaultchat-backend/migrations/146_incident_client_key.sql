-- 146_incident_client_key.sql — one incident per driver SOS press, and when it
-- was pressed.
--
-- NOT APPLIED ANYWHERE. Written 2026-10-04 (round 8); scratch-DB only.
-- Apply BEFORE deploying the Go code that writes these columns
-- (internal/routes/spaces_ops.go incidentCreate / incidentList).
--
-- The driver's emergency alert is kept on the phone and retried until the
-- server answers (lib/spaces/sosOutbox). A request that reached the server but
-- whose answer was lost on a bad signal is sent again, and every copy pushed the
-- office and every guardian on the run. The client now sends a key minted once
-- per alert (a uuid); this index makes a repeat of that key the same incident
-- (INSERT ... ON CONFLICT DO NOTHING, then the existing id is answered).
--
-- pressed_at: the phone's press time. An alert delivered late used to look
-- fresh — the server stamped created_at on arrival and pushed "an emergency has
-- been reported" as if it were happening now. NULL = the client did not say
-- (every older client, every non-SOS incident).
--
-- Additive, nullable, instant on an existing table; older clients send neither
-- field and are unaffected. Reverse: migrations/down/146_incident_client_key.sql.

ALTER TABLE space_incidents ADD COLUMN IF NOT EXISTS client_key TEXT;
ALTER TABLE space_incidents ADD COLUMN IF NOT EXISTS pressed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'space_incidents'::regclass
       AND conname = 'space_incidents_client_key_len'
  ) THEN
    ALTER TABLE space_incidents
      ADD CONSTRAINT space_incidents_client_key_len
      CHECK (client_key IS NULL OR char_length(client_key) BETWEEN 8 AND 64);
  END IF;
END $$;

-- Per reporter within a space: a key is only ever compared with the same
-- driver's own presses.
CREATE UNIQUE INDEX IF NOT EXISTS uq_space_incidents_client_key
  ON space_incidents(chat_id, reporter_id, client_key)
  WHERE client_key IS NOT NULL;
