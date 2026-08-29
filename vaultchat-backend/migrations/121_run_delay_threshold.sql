-- 121_run_delay_threshold.sql — the per-space run-delay threshold, and the gap
-- it closes: "run delayed beyond threshold" was evaluated ONLY on the viewing
-- device (lib/spaces/runs.ts isDelayed), so a guardian whose app was closed was
-- never told the bus is late — the one moment the feature exists for.
--
-- One column on chats, exactly like shift_grace_minutes in 087: a threshold
-- belongs to the workplace, not to a run. DEFAULT 10 matches the client's
-- isDelayed(…, thresholdMinutes = 10), so the two sides agree before any admin
-- touches a setting.
--
-- The evaluator itself is event-driven in Go (spaces_runs.go, on the driver's
-- heartbeat ping): the server holds NO position — a delay is derived from
-- planned_at vs NOW() on stops that have not been reached, which is data the
-- server already has. run_events(kind='run_delayed', ref_id=stop) is the dedup
-- ledger: one notification per overdue stop, ever.

ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS run_delay_threshold_minutes INT NOT NULL DEFAULT 10;
