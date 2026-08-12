-- 101_broadcast_segment_retention.sql — mark when a broadcast's HLS segments
-- were reclaimed. Idempotent. Additive. Deletes nothing.
--
-- WHY
-- ---
-- Broadcast segments had no lifecycle whatsoever. They live in
-- BROADCAST_BUCKET with no row in `attachments`, and every storage-deleting job
-- enumerates `FROM attachments` — so nothing could even ENUMERATE them, let
-- alone reclaim them. Every 4-second segment of every broadcast ever made was
-- retained forever, on the same box that runs Postgres.
--
-- internal/jobs.sweepEndedBroadcasts now purges them a configurable number of
-- days after the stream ended (BROADCAST_RETENTION_DAYS, default 30, 0 to
-- disable). This column is what makes that sweep idempotent: without it the job
-- would re-list and re-delete the same prefixes on every tick forever, since a
-- prefix delete leaves nothing behind to indicate it already ran.
--
-- Driven by ended_at rather than by broadcastEnd, because deleting at
-- end-of-stream would destroy replay the moment a host stops.

ALTER TABLE broadcast_sessions
  ADD COLUMN IF NOT EXISTS segments_purged_at TIMESTAMPTZ;

-- The sweep asks for ended-and-not-yet-purged. Partial, because a purged row is
-- never a candidate again and indexing them would cost writes for a query that
-- is never made.
CREATE INDEX IF NOT EXISTS idx_broadcast_sessions_purgeable
  ON broadcast_sessions (ended_at)
  WHERE ended_at IS NOT NULL AND segments_purged_at IS NULL;
