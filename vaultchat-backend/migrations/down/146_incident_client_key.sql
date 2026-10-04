-- down/146_incident_client_key.sql — reverse 146_incident_client_key.sql.
-- Lives in down/ so the migration runner does not see a duplicate version 146.
-- Deploy the Go code WITHOUT the client_key / pressed_at writes first
-- (spaces_ops.go incidentCreate, incidentList). Loses only the press times and
-- keys; the incidents themselves are untouched.
--
-- Run: psql -f migrations/down/146_incident_client_key.sql. Never against production.

DROP INDEX IF EXISTS uq_space_incidents_client_key;
ALTER TABLE space_incidents DROP CONSTRAINT IF EXISTS space_incidents_client_key_len;
ALTER TABLE space_incidents DROP COLUMN IF EXISTS pressed_at;
ALTER TABLE space_incidents DROP COLUMN IF EXISTS client_key;
