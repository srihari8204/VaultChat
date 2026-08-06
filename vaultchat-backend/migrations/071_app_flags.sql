-- 071_app_flags.sql
-- Idempotent.
--
-- The remote feature-flag channel: a server-driven kill switch and percentage
-- rollout for flags that ship as compile-time constants in constants/flags.ts.
--
-- WHY THIS EXISTS
-- ---------------
-- Every flag in the app is a `const` baked into the binary, so "turn it off"
-- means "cut a release and wait for the stores". That is not a rollback story
-- for a change that moves user data — it is a wish. This table is the smallest
-- thing that makes one real.
--
-- ABSENT ROW = NO OPINION, AND THAT IS THE SAFE STATE
-- --------------------------------------------------
-- The client reads a row only as an OVERRIDE. A key with no row, an endpoint
-- that 404s, a server that is down, a device that is offline — all of them
-- resolve to the value compiled into the build, which is the value that was
-- tested and shipped. So an empty table behaves exactly like today, and no
-- failure of this channel can push a fleet onto an untested code path.
--
-- THE THREE LEVERS
-- ----------------
--   killed       Emergency off. Unconditional, and it outranks rollout_pct,
--                min_build and any cached client value. This is the lever you
--                reach for at 3am; it is deliberately a separate column from
--                rollout_pct = 0 so that "we turned it off in a hurry" and "we
--                have not started rolling out" are never confused in an audit.
--
--   rollout_pct  The canary dial: 0, 1, 10, 25, 50, 100. Bucketing is
--                sha256(key || ':' || device_id) mod 100 < rollout_pct, so a
--                device's bucket for a given key NEVER moves. Raising the
--                percentage only ever ADDS devices; it cannot churn a device
--                back out, which is what makes "1 -> 10 -> 25" monotone for the
--                user as well as for the operator.
--
--   min_build    Version floor. A flag can be safe at 100% among new builds and
--                unsafe against an old one — VB_SEAMLESS_RESUME writes a v2
--                segment plan, and only a build carrying lib/vaultBeamSegments
--                v2 can read it. Gating on the client's build number is how the
--                rollout waits for adoption instead of assuming it.
--
-- NO RLS, DELIBERATELY
-- --------------------
-- This is app-wide operational config, not user data: no user id appears in it
-- and every caller gets an answer computed from their own device id. It carries
-- no row-level policy because there are no rows to scope. It is read through
-- db.SysPool for exactly that reason, and it holds NOTHING sensitive — the flag
-- names are already in the shipped binary.

CREATE TABLE IF NOT EXISTS app_flags (
  key         TEXT PRIMARY KEY,
  killed      BOOLEAN     NOT NULL DEFAULT FALSE,
  rollout_pct SMALLINT    NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  min_build   INTEGER,
  note        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seeded at 0% and not killed: the channel is live, the rollout has not begun,
-- and the client keeps using its compiled default until an operator moves the
-- dial. Seeding the row (rather than leaving it absent) is what makes the
-- kill switch reachable the moment the endpoint ships.
INSERT INTO app_flags (key, killed, rollout_pct, note)
VALUES ('VB_SEAMLESS_RESUME', FALSE, 0,
        'Transport-independent transfer session. Raise only after the 14-row transport matrix passes on device; set min_build first so v2 segment plans are never sent to a build that cannot read them.')
ON CONFLICT (key) DO NOTHING;
