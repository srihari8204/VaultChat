-- 115_games_notify_seen.sql — replay protection for POST /games/notify.
--
-- The games server signs each turn/invite event with a jti and retries
-- deliveries it does not get a 2xx for. Without a record of what has already
-- been delivered, every retry is a second buzz on the recipient's phone for a
-- turn they have already been told about.
--
-- A TABLE AND NOT AN IN-MEMORY SET. The events are short-lived (5 minutes), so
-- a map would be tempting, but the case that produces retries is the case where
-- the API restarted or is running behind more than one container — exactly when
-- process memory is the wrong place to keep the answer.
--
-- Rows are claimed before the push is attempted and released if it fails, so
-- this doubles as the in-flight claim. See gamesNotifyClaimJTI in
-- internal/routes/games_notify.go.

CREATE TABLE IF NOT EXISTS games_notify_seen (
  -- The event's own jti. PRIMARY KEY, so the dedupe is the constraint rather
  -- than a read-then-write that can lose a race with a concurrent retry.
  jti        text        PRIMARY KEY,
  -- The event's exp. Kept so the sweep can drop a row once no valid token
  -- carrying that jti could still arrive — pruning on seen_at instead would
  -- guess at a lifetime the token already states.
  expires_at timestamptz NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now()
);

-- The sweep in internal/jobs deletes on expires_at; without this it is a
-- sequential scan of the whole table on every tick.
CREATE INDEX IF NOT EXISTS idx_games_notify_seen_expires
  ON games_notify_seen (expires_at);
