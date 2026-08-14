-- 103_space_locations.sql — server-side location store for Spaces.
--
-- ARCHITECTURE DECISION REVERSAL (owner-directed, 2026-08-14): location data
-- inside an authorized Space no longer requires E2EE. Earlier migrations and
-- file headers (091, spaces_runs.go, spaces_devices.go) deliberately refused
-- to store a person's coordinates; that refusal is superseded FOR SPACE
-- LOCATION DATA by the all-space location platform directive. What replaces
-- cryptography as the boundary is SERVER-SIDE AUTHORIZATION: every read is
-- gated by space membership + space type + role/permission + the visibility
-- graph (space_links) + run assignment. The sealed relay keeps working for
-- clients that use it; this store is additive.
--
-- Shape notes:
--  - One row per accepted point. Ingest batches and dedupes; the app writes
--    at presence cadence (seconds), history queries read minutes-to-days.
--  - (chat_id, user_id, ts) unique: replays and offline re-uploads collapse.
--  - No FK to messages/runs: points outlive both, and retention is a sweep
--    (see idx below), not a cascade.
--  - duty_state is stamped AT INGEST from chat_members.duty_state so history
--    answers "was this during duty hours" without a join against mutable
--    present-tense state.

CREATE TABLE IF NOT EXISTS space_locations (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT,                          -- X-Device-Id when the client sent one
  lat         DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m  REAL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  altitude_m  REAL,
  speed_mps   REAL CHECK (speed_mps IS NULL OR speed_mps >= 0),
  heading_deg REAL CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
  battery     SMALLINT CHECK (battery IS NULL OR battery BETWEEN 0 AND 100),
  ts          TIMESTAMPTZ NOT NULL,          -- the FIX time, from the device
  source      TEXT NOT NULL DEFAULT 'gps'
              CHECK (source IN ('gps','network','fused','manual')),
  duty_state  TEXT,                          -- chat_members.duty_state at ingest, if any
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_space_locations_point UNIQUE (chat_id, user_id, ts)
);

-- Latest-per-member and history are the two read shapes; both start from
-- (chat_id, user_id) and scan ts backwards.
CREATE INDEX IF NOT EXISTS idx_space_locations_member_ts
  ON space_locations (chat_id, user_id, ts DESC);
-- The retention sweep deletes by age across all spaces.
CREATE INDEX IF NOT EXISTS idx_space_locations_created
  ON space_locations (created_at);

-- Latest point per member of one space — the live-map query. SECURITY INVOKER
-- on purpose: the CALLER's WHERE clause (the policy) restricts which members
-- may appear; this view only answers "newest per member".
CREATE OR REPLACE VIEW space_locations_latest AS
  SELECT DISTINCT ON (chat_id, user_id) *
  FROM space_locations
  ORDER BY chat_id, user_id, ts DESC;
