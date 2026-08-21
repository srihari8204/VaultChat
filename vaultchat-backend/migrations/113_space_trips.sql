-- 113_space_trips.sql — server-backed family trips (shared destination).
--
-- WHY A TABLE: the trip used to live only in an E2EE chat message
-- (VCTRIP1:… announce). Discovering it required decrypting group history,
-- which is exactly the path that silently breaks when a member pair's
-- sender-key session wedges — a family could be mid-drive with half the
-- phones unable to learn the trip exists. Space activities are exempt from
-- E2EE by owner directive (2026-08-21, same reversal as migration 103), so
-- the trip itself — a destination the circle chose to share — moves to the
-- server, where a late joiner reads it with one authorized GET.
--
-- Members' ETAs still ride the socket relay only (nothing stored): a trip is
-- ephemeral, and nobody wants last Tuesday's convoy in a table.
--
-- One ACTIVE trip per space, enforced by a partial unique index: two members
-- racing "start" resolves in the database, not in client timing.

CREATE TABLE IF NOT EXISTS space_trips (
  id               BIGSERIAL PRIMARY KEY,
  chat_id          UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  destination_name TEXT NOT NULL,
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  started_by       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Follow-the-leader: everyone measures "off route" against this member's
  -- road. NULL = each phone judges against its own route.
  leader_id        UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ NULL,
  ended_by         UUID NULL REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT space_trips_lat_ck CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT space_trips_lng_ck CHECK (lng BETWEEN -180 AND 180),
  CONSTRAINT space_trips_name_ck CHECK (length(destination_name) BETWEEN 1 AND 200)
);

-- The race-proof "one active trip per space" rule.
CREATE UNIQUE INDEX IF NOT EXISTS space_trips_active_uq
  ON space_trips (chat_id) WHERE ended_at IS NULL;

-- History reads (and the TTL filter) scan per space, newest first.
CREATE INDEX IF NOT EXISTS space_trips_chat_idx
  ON space_trips (chat_id, started_at DESC);
