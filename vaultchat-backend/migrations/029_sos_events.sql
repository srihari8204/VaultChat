-- Emergency SOS history (emergency-sos screen). Idempotent.
--
-- One row per SOS dispatch (real or test). The actual alerting is a push to
-- the sender's trusted contacts (routes/user.js); this table is the history.

CREATE TABLE IF NOT EXISTS sos_events (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT        NOT NULL,            -- 'emergency' | 'test'
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  contacts_notified INT         NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sos_events_user ON sos_events(user_id, created_at DESC);
