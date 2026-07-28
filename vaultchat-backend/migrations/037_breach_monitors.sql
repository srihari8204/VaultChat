-- Breach-monitor list (breachguard screen). Idempotent.
--
-- The targets a user asks VaultChat to watch for data-breach exposure. The
-- breach LOOKUP itself runs ON-DEVICE (the HIBP API key never leaves the phone);
-- this table only persists WHICH targets are monitored + the last result count,
-- so the watch list survives reinstall and syncs across the user's devices.

CREATE TABLE IF NOT EXISTS breach_monitors (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type     TEXT         NOT NULL DEFAULT 'email',   -- 'email'
  target          TEXT         NOT NULL,                    -- watched value (e.g. an email)
  breach_count    INT          NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, target_type, target)
);

CREATE INDEX IF NOT EXISTS idx_breach_monitors_user ON breach_monitors(user_id, created_at DESC);
