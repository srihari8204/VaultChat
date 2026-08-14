-- 104_location_sharing_state.sql — explicit per-member location-sharing state.
--
-- The platform's implicit rule ("uploading is the act of sharing") cannot
-- express an EXPLICIT stop: after one, the server must refuse further uploads
-- for that member (client bugs or a stale background task must not keep
-- publishing), viewers must be told the reason ("sharing off", not silence),
-- and the last-known point must remain readable (nothing is deleted — spec:
-- the disable event is not a GPS location and must never destroy one).
--
-- NULL = never explicitly set → legacy behaviour (upload implies sharing).
-- TRUE/FALSE = the member's own explicit choice; only their own request may
-- change it (spaces_locations.go locStart/locStop — an admin cannot force it).

ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS location_sharing_enabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS location_sharing_changed_at TIMESTAMPTZ;
