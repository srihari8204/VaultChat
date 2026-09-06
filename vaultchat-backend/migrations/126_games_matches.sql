-- 126_games_matches.sql
-- Idempotent.
--
-- Pool (101/201) and Deals (best-of-2/6) rummy, as a match layer over the games
-- server's single-deal engine.
--
-- WHY THIS EXISTS
--
-- docs/GAMES_PROTOCOL.md, written against the shipped server clients: "There is
-- no pool (101/201) and no deals variant on this server: the wire protocol has
-- no pool score, no elimination and no deal count, and the engine only ever
-- settles a single deal at a time." The games server is a separate deployment
-- we do not own the source of, so no engine change is available to us.
--
-- But Pool and Deals ARE just scoring wrappers around repeated Points deals,
-- and the server already hands every client the two inputs one needs: the
-- per-deal result (`settlement` and `players[].points`) and `start`, which
-- re-deals the same table with the seats it has. So a match is a sequence of
-- server-owned deals plus a score that VaultChat owns. This is that score.
--
-- WHY THE SERVER HOLDS IT AND NOT THE DEVICE
--
-- A pool score decides who is ELIMINATED, which makes it adversarial state.
-- Two reasons a client cannot hold it:
--   1. A disconnect loses a deal. Connections here drop routinely (the games
--      board has a reconnect banner for exactly this). A player who misses one
--      deal's settlement carries a lower total than everyone else — and in Pool
--      that is the difference between eliminated and still playing.
--   2. Every seat must agree, and there is no game-over event in the games
--      contract to reconcile against. If each device totals what it happened to
--      witness, nothing ever settles the disagreement.
--
-- SCORING LIVES IN GO, NOT HERE AND NOT IN THE APP
--
-- One implementation, server-side (games_matches.go), per the thin-client rule.
-- Duplicating the rules in TypeScript to render them would be two sources of
-- truth for who is out of a match.
--
-- WHY scores IS JSONB
--
-- A roster is at most six players and is always read and written whole, by one
-- statement, under the optimistic-concurrency guard below. A child table would
-- add a join and a second write for no benefit. It is deliberately NOT indexed
-- into: nothing queries "all matches where player X leads".
--
-- PRACTICE TABLES ONLY — enforced in the handler, recorded here
--
-- A staked table settles COINS on every deal (that is what settlement.delta
-- is), but Pool's actual rule is that money moves once, at the end of the
-- match. A pool over a staked table would therefore charge a player per deal by
-- the games server AND per match by us — the same loss taken twice, and the
-- second one invisible to the server that took the first. `pointValue = 0`
-- marks a practice table; only those may host a match.
--
-- No RLS policy is written. RLS is inert in production — the API connects as a
-- superuser and bypasses every policy — so a policy here would be a comforting
-- lie. The handlers scope by the caller's own vault id themselves.

CREATE TABLE IF NOT EXISTS games_matches (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The games server's table id. Not a foreign key: that server owns tables and
  -- this database has never heard of them.
  table_id      TEXT        NOT NULL,

  variant       TEXT        NOT NULL
                CHECK (variant IN ('pool101', 'pool201', 'deals2', 'deals6')),

  -- Who opened the match. Vault ids, because that is the only identity the
  -- games server ever sees (the launch token carries vaultId + name, nothing
  -- else) — so it is the only id that can be matched to a seat at a table.
  host_vault_id TEXT        NOT NULL,

  status        TEXT        NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'finished')),

  -- THE CONCURRENCY GUARD, and the reason this column is not merely a counter.
  --
  -- Every client at the table watches the same deal end, so all six will try to
  -- report it. A client posts the deal INDEX it believes it is reporting, and
  -- the update applies only where deals_played still equals that index. The
  -- first writer wins and the other five are no-ops that read back the same
  -- state. Without this, one deal is counted once per player and every score is
  -- multiplied by the seat count.
  deals_played  INT         NOT NULL DEFAULT 0,

  -- { vaultId: { name, points, chips, status } }
  --   points — accumulated deal points; the pool total that eliminates.
  --   chips  — the Deals-variant running chip count.
  --   status — 'playing' | 'out'.
  scores        JSONB       NOT NULL DEFAULT '{}'::JSONB,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only read on the hot path: "is there a live match at this table?", asked
-- by every client each time it opens a board. Partial, because a finished match
-- is never looked up this way.
CREATE UNIQUE INDEX IF NOT EXISTS games_matches_live_table_idx
  ON games_matches (table_id)
  WHERE status = 'running';

-- The sweep drops long-dead matches. There is no game-over event in the games
-- contract, so a match whose players simply walked away is never finished by
-- anyone and would otherwise sit in that unique index forever, blocking a new
-- match at the same table.
CREATE INDEX IF NOT EXISTS games_matches_updated_idx
  ON games_matches (updated_at);

COMMENT ON TABLE games_matches IS
  'Pool (101/201) and Deals (best-of-2/6) rummy matches layered over the games '
  'server''s single-deal engine (migration 126). The games server is '
  'authoritative for every deal; this is authoritative only for the score '
  'ACROSS deals, because that decides elimination and every seat must agree on '
  'it. Practice tables only — a staked table already settles coins per deal.';

COMMENT ON COLUMN games_matches.deals_played IS
  'Deals applied so far, and the optimistic-concurrency guard: an advance is '
  'accepted only when the caller''s deal index equals this value, so the same '
  'deal reported by all six seats is counted exactly once.';
