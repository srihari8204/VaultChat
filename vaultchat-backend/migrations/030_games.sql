-- Multiplayer gaming persistence (game-lobby / game-play). Idempotent.
--
-- The realtime layer (matchmaking, move relay) lives in the Socket.IO layer
-- in server.js and stays in-memory for low latency. These tables are the
-- durable layer: per-user coin balance / win-loss record, and a match log.
-- Route + socket enforced; no RLS.

CREATE TABLE IF NOT EXISTS game_profiles (
  user_id      UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  coins        INT         NOT NULL DEFAULT 1000,
  wins         INT         NOT NULL DEFAULT 0,
  losses       INT         NOT NULL DEFAULT 0,
  games_played INT         NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_matches (
  id         TEXT        PRIMARY KEY,            -- the realtime roomId
  game_type  TEXT        NOT NULL,
  player_a   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_b   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bet        INT         NOT NULL DEFAULT 0,
  winner_id  UUID        REFERENCES users(id) ON DELETE SET NULL,
  status     TEXT        NOT NULL DEFAULT 'active',  -- 'active' | 'finished' | 'abandoned'
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_game_matches_player_a ON game_matches(player_a, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_matches_player_b ON game_matches(player_b, started_at DESC);
