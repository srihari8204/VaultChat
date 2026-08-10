-- 079_broadcast.sql — live broadcast sessions (metadata only). Idempotent.
--
-- WHY
-- ---
-- Broadcast is the third communication mode and the only one that is NOT
-- end-to-end encrypted, by design: viewers are unbounded and receive HLS from a
-- CDN, so there is no key exchange that could reach them. That is the same
-- decision YouTube and Twitch make, and it must be visible in the UI rather
-- than assumed — see broadcast_sessions.e2ee below, which exists so a client
-- can never render a padlock over a stream that has none.
--
-- WHAT THIS TABLE IS NOT
-- ----------------------
-- It stores METADATA. No media, no segments, no thumbnails. The video lives in
-- object storage behind a CDN and is referenced by hls_url. Putting media bytes
-- in Postgres is the classic way to make a database unrestorable — this schema
-- dumps in 500 KB today and must stay that way.
--
-- REAL-TIME STATE DOES NOT LIVE HERE EITHER
-- -----------------------------------------
-- viewer_count is a periodically-written SNAPSHOT for listings and history, not
-- the live counter. A live count updated per join/leave would mean one UPDATE
-- per viewer per event on a row every viewer also reads — a guaranteed hot-row
-- lock convoy at exactly the moment a stream goes viral. Redis holds the live
-- value; this column is refreshed on a timer and at end-of-stream so the
-- historical record survives a Redis flush.
--
-- Chat is deliberately a separate table with no FK-driven cascade on delete of
-- the session: an ended broadcast keeps its transcript for moderation review.

-- ── sessions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcast_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Optional: a broadcast started from inside a chat/community. NULL for a
  -- public stream that belongs to no chat.
  chat_id      UUID REFERENCES chats(id) ON DELETE SET NULL,
  title        TEXT NOT NULL DEFAULT '',
  -- live → ended is the only legal transition; 'starting' covers the window
  -- between creating the row and egress actually producing a playlist, so the
  -- UI can show "going live" instead of a broken player.
  status       TEXT NOT NULL DEFAULT 'starting'
                 CHECK (status IN ('starting', 'live', 'ended', 'failed')),
  -- Playback URL served by the CDN. NULL until egress reports the playlist.
  hls_url      TEXT,
  -- LiveKit room the publisher joins. Kept so egress can be restarted for a
  -- stream that is still live after a worker crash.
  room         TEXT NOT NULL DEFAULT '',
  -- Honest labelling. Broadcast is not E2EE; this is stored rather than assumed
  -- so a future encrypted mode cannot be mistaken for this one, and so the
  -- client renders the security state from data instead of from a hardcoded
  -- guess about the mode.
  e2ee         BOOLEAN NOT NULL DEFAULT FALSE,
  -- Snapshot only — see header. Live value is in Redis.
  viewer_count INTEGER NOT NULL DEFAULT 0,
  peak_viewers INTEGER NOT NULL DEFAULT 0,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ
);

-- "What is live right now" is the query every listing runs; partial index keeps
-- it independent of how much ENDED history accumulates.
CREATE INDEX IF NOT EXISTS broadcast_sessions_live_idx
  ON broadcast_sessions (started_at DESC) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS broadcast_sessions_host_idx
  ON broadcast_sessions (host_id, started_at DESC);

-- ── live chat ─────────────────────────────────────────────────────────
-- Plaintext, deliberately: a broadcast has no key exchange with its audience.
-- Anyone who can watch can read the chat, which is what the mode means.
CREATE TABLE IF NOT EXISTS broadcast_chat (
  id           BIGSERIAL PRIMARY KEY,
  broadcast_id UUID NOT NULL REFERENCES broadcast_sessions(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chat is read newest-first for one broadcast; this is the only access pattern.
CREATE INDEX IF NOT EXISTS broadcast_chat_stream_idx
  ON broadcast_chat (broadcast_id, id DESC);

-- ── viewer sessions (analytics, NOT the live counter) ─────────────────
-- One row per viewing session, written on join and closed on leave. Used for
-- watch-time and unique-viewer reporting after the fact. The live count comes
-- from Redis; nothing in the hot path writes here more than twice per viewer.
CREATE TABLE IF NOT EXISTS broadcast_viewers (
  id           BIGSERIAL PRIMARY KEY,
  broadcast_id UUID NOT NULL REFERENCES broadcast_sessions(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,   -- NULL = anonymous
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS broadcast_viewers_stream_idx
  ON broadcast_viewers (broadcast_id, joined_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────
-- Same shape as 066_call_sessions: the API sets the current user and the
-- database enforces who may write. A broadcast is PUBLICLY readable — that is
-- the point of the mode — but only its host may create or end it.
ALTER TABLE broadcast_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_sessions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_sessions_select ON broadcast_sessions;
DROP POLICY IF EXISTS broadcast_sessions_insert ON broadcast_sessions;
DROP POLICY IF EXISTS broadcast_sessions_update ON broadcast_sessions;

CREATE POLICY broadcast_sessions_select ON broadcast_sessions FOR SELECT USING (TRUE);
-- You may only go live AS yourself.
CREATE POLICY broadcast_sessions_insert ON broadcast_sessions FOR INSERT
  WITH CHECK (host_id = vc_current_user_id());
-- Only the host may change status, publish the URL, or end the stream.
CREATE POLICY broadcast_sessions_update ON broadcast_sessions FOR UPDATE
  USING (host_id = vc_current_user_id());

ALTER TABLE broadcast_chat ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_chat FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_chat_select ON broadcast_chat;
DROP POLICY IF EXISTS broadcast_chat_insert ON broadcast_chat;

CREATE POLICY broadcast_chat_select ON broadcast_chat FOR SELECT USING (TRUE);
-- Post as yourself, and only into a stream that is still live — a closed
-- broadcast must not keep accepting messages.
CREATE POLICY broadcast_chat_insert ON broadcast_chat FOR INSERT WITH CHECK (
  user_id = vc_current_user_id()
  AND EXISTS (
    SELECT 1 FROM broadcast_sessions b
     WHERE b.id = broadcast_id AND b.status = 'live'
  )
);

ALTER TABLE broadcast_viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_viewers FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_viewers_select ON broadcast_viewers;
DROP POLICY IF EXISTS broadcast_viewers_insert ON broadcast_viewers;
DROP POLICY IF EXISTS broadcast_viewers_update ON broadcast_viewers;

-- Viewing figures are the host's business, not every viewer's.
CREATE POLICY broadcast_viewers_select ON broadcast_viewers FOR SELECT USING (
  EXISTS (SELECT 1 FROM broadcast_sessions b
           WHERE b.id = broadcast_id AND b.host_id = vc_current_user_id())
);
CREATE POLICY broadcast_viewers_insert ON broadcast_viewers FOR INSERT
  WITH CHECK (user_id IS NULL OR user_id = vc_current_user_id());
CREATE POLICY broadcast_viewers_update ON broadcast_viewers FOR UPDATE
  USING (user_id = vc_current_user_id());
