-- 144_sos_contacts_reached.sql — how many trusted contacts an SOS actually reached.
--
-- NOT APPLIED ANYWHERE. Written 2026-10-04 (round 4); scratch-DB only.
--
-- contacts_notified counts the contacts an SOS was ADDRESSED to, including
-- contacts with no registered device, so the app's "N alerted" could claim
-- people the alert never left the server for. contacts_reached counts the
-- contacts for whom the push provider (Expo) ACCEPTED a notification for at
-- least one of their devices (ticket status "ok"). That is the strongest fact
-- the send path has; actual on-device display would need Expo push receipts,
-- which are not polled.
--
-- NULL = not recorded (rows from before this migration). Additive, nullable,
-- instant. Reverse:
--   ALTER TABLE sos_events DROP COLUMN IF EXISTS contacts_reached;

ALTER TABLE sos_events ADD COLUMN IF NOT EXISTS contacts_reached INT;
