-- 125_games_live_tables.sql
-- Idempotent.
--
-- One row per table a player is sitting at, so a game survives closing the app.
--
-- WHY THIS EXISTS
--
-- The games platform has ~19 registered players and typically zero online at
-- the same moment, so Quick Match nearly always falls through to a bot offer.
-- Asynchronous play — you move, your opponent gets a push, they play hours
-- later — is the only structural fix for that, and it is the loop Chess.com is
-- built on. The push half already exists (games_notify.go, migration 115). This
-- is the half that gives it somewhere to land: without a list, a player who
-- misses or dismisses the notification has no way back to their own game.
--
-- DERIVED, NOT AUTHORITATIVE
--
-- The games server owns every table. It is a separate deployment we do not own
-- the source of, and it exposes no endpoint for "the tables this player is at",
-- so this cannot be a read-through. What it DOES do is sign a notification for
-- every turn — so this table records what it has already told us, and nothing
-- more. Opening a table re-syncs from the server's own snapshot, which is
-- authoritative the moment the socket connects.
--
-- The consequence, stated plainly: a row is only as fresh as the last
-- notification, and there is NO game-over event in the contract (the kinds are
-- turn | invite | friend). So rows are swept by age, and the app deletes one
-- when it opens the table and finds the game finished — the client is the only
-- party that ever learns a game ended.
--
-- WHAT IT HOLDS, AND WHY SO LITTLE
--
-- title/body are the human-readable lines the games server already wrote for
-- the push. Storing them means the list renders what the server said rather
-- than the app inventing a sentence about a game whose state it cannot see —
-- the thin-client rule, and the same reason nothing here stores a turn deadline
-- (the notify contract carries none; the board gets the real one over the
-- WebSocket every frame).
--
-- No RLS policy is written. RLS is inert in production — the API connects as a
-- superuser and bypasses every policy — so a policy here would be a comforting
-- lie. The read and delete handlers scope by user_id themselves.

CREATE TABLE IF NOT EXISTS games_live_tables (
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Slugs, validated by gamesNotifySlug before they are written: both end up
  -- in a deep link the app opens.
  game       TEXT        NOT NULL,
  room       TEXT        NOT NULL,
  -- Whether the last thing we heard was "your turn". Not a claim about the
  -- board — a record of the last notification.
  your_turn  BOOLEAN     NOT NULL DEFAULT TRUE,
  title      TEXT,
  body       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game, room)
);

-- The list is always read for one player, newest first.
CREATE INDEX IF NOT EXISTS games_live_tables_user_idx
  ON games_live_tables (user_id, updated_at DESC);

-- The sweep drops rows nobody has heard about in a fortnight. Without this
-- index that is a sequential scan on every tick, exactly as migration 115 said
-- of games_notify_seen.
CREATE INDEX IF NOT EXISTS games_live_tables_updated_idx
  ON games_live_tables (updated_at);

COMMENT ON TABLE games_live_tables IS
  'Tables a player is seated at, derived from the games server''s signed turn '
  'notifications (migration 125). A launcher, not a source of truth: the games '
  'server is authoritative and is re-read the moment a table is opened. There '
  'is no game-over event in the notify contract, so rows age out and the app '
  'deletes one when it opens a finished table.';
