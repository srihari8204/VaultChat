-- 080_broadcast_egress.sql — remember which egress job serves a broadcast.
--
-- WHY
-- ---
-- 079 stored where a stream can be WATCHED (hls_url) but not what is PRODUCING
-- it. Without the egress id there is no way to stop a running job: ending a
-- broadcast would flip the row to 'ended', viewers would drop, and a Chrome +
-- ffmpeg process would keep transcoding and writing segments to object storage
-- indefinitely. That is the most expensive kind of leak in this stack, because
-- egress is the only CPU-bound service here.
--
-- Nullable on purpose: a session exists before egress is asked to start, and a
-- deployment with no egress service configured must still be able to create and
-- end broadcast rows rather than failing at INSERT.
ALTER TABLE broadcast_sessions
  ADD COLUMN IF NOT EXISTS egress_id TEXT;

-- Finding jobs that outlived their session — the leak described above, if one
-- ever escapes. Partial: only rows that still hold a job are interesting.
CREATE INDEX IF NOT EXISTS broadcast_sessions_egress_idx
  ON broadcast_sessions (egress_id) WHERE egress_id IS NOT NULL;
