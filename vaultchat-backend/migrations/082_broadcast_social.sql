-- 082_broadcast_social.sql — invitations, likes and comments on a broadcast.
-- Idempotent.
--
-- WHY LIKES ARE NOT A COLUMN
-- --------------------------
-- The obvious design is `broadcast_sessions.like_count` and an UPDATE per tap.
-- That is one write to a single row per like, on a row every viewer is also
-- reading — the same hot-row lock convoy that kept viewer_count out of
-- Postgres, except likes are burstier: a good moment in a stream produces
-- hundreds of taps in a second.
--
-- One row per (broadcast, user) instead. It is idempotent by construction — a
-- primary key makes double-tap a no-op rather than an inflated number — and the
-- total is a COUNT over an index. Live totals belong in Redis; this is the
-- durable record.
--
-- COMMENTS vs CHAT
-- broadcast_chat (079) is ephemeral talk DURING a stream. Comments persist
-- after it ends, which is a different lifetime and a different moderation
-- problem, so they get their own table rather than a flag on the same one.

-- ── invitations ───────────────────────────────────────────────────────
-- Who was invited, by whom, and whether they have seen it. A broadcast is
-- public to anyone with the link; an invitation is how it REACHES someone.
CREATE TABLE IF NOT EXISTS broadcast_invites (
  id           BIGSERIAL PRIMARY KEY,
  broadcast_id UUID NOT NULL REFERENCES broadcast_sessions(id) ON DELETE CASCADE,
  inviter_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at      TIMESTAMPTZ,
  -- Inviting the same person twice is a no-op, not a second notification.
  UNIQUE (broadcast_id, invitee_id)
);

-- "What am I invited to?" is the only query a client runs here.
CREATE INDEX IF NOT EXISTS broadcast_invites_invitee_idx
  ON broadcast_invites (invitee_id, created_at DESC);

-- ── likes ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcast_likes (
  broadcast_id UUID NOT NULL REFERENCES broadcast_sessions(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotence lives in the schema: a double tap cannot double count.
  PRIMARY KEY (broadcast_id, user_id)
);

-- ── comments ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcast_comments (
  id           BIGSERIAL PRIMARY KEY,
  broadcast_id UUID NOT NULL REFERENCES broadcast_sessions(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft delete: a removed comment must stay auditable for moderation, and a
  -- hard DELETE would also renumber nothing but lose the evidence.
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS broadcast_comments_stream_idx
  ON broadcast_comments (broadcast_id, id DESC) WHERE deleted_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────
-- Same shape as 079: broadcasts are public to read, and writes are scoped to
-- the acting user. The database is the authority, not the handler.
ALTER TABLE broadcast_invites  ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_invites  FORCE  ROW LEVEL SECURITY;
ALTER TABLE broadcast_likes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_likes    FORCE  ROW LEVEL SECURITY;
ALTER TABLE broadcast_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_comments FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_invites_select ON broadcast_invites;
DROP POLICY IF EXISTS broadcast_invites_insert ON broadcast_invites;
DROP POLICY IF EXISTS broadcast_invites_update ON broadcast_invites;

-- You see invitations addressed to you, and ones you sent.
CREATE POLICY broadcast_invites_select ON broadcast_invites FOR SELECT
  USING (invitee_id = vc_current_user_id() OR inviter_id = vc_current_user_id());
-- Invite AS yourself only — otherwise anyone could forge an invitation that
-- appears to come from a trusted contact.
CREATE POLICY broadcast_invites_insert ON broadcast_invites FOR INSERT
  WITH CHECK (inviter_id = vc_current_user_id());
-- Marking one seen is the only update, and only the recipient may do it.
CREATE POLICY broadcast_invites_update ON broadcast_invites FOR UPDATE
  USING (invitee_id = vc_current_user_id());

DROP POLICY IF EXISTS broadcast_likes_select ON broadcast_likes;
DROP POLICY IF EXISTS broadcast_likes_insert ON broadcast_likes;
DROP POLICY IF EXISTS broadcast_likes_delete ON broadcast_likes;

CREATE POLICY broadcast_likes_select ON broadcast_likes FOR SELECT USING (TRUE);
CREATE POLICY broadcast_likes_insert ON broadcast_likes FOR INSERT
  WITH CHECK (user_id = vc_current_user_id());
-- Unlike removes only your own.
CREATE POLICY broadcast_likes_delete ON broadcast_likes FOR DELETE
  USING (user_id = vc_current_user_id());

DROP POLICY IF EXISTS broadcast_comments_select ON broadcast_comments;
DROP POLICY IF EXISTS broadcast_comments_insert ON broadcast_comments;
DROP POLICY IF EXISTS broadcast_comments_update ON broadcast_comments;

CREATE POLICY broadcast_comments_select ON broadcast_comments FOR SELECT USING (TRUE);
CREATE POLICY broadcast_comments_insert ON broadcast_comments FOR INSERT
  WITH CHECK (user_id = vc_current_user_id());
-- Delete your own comment, or — as the host — one on your stream. Moderation
-- has to reach other people's words or it is not moderation.
CREATE POLICY broadcast_comments_update ON broadcast_comments FOR UPDATE USING (
  user_id = vc_current_user_id()
  OR EXISTS (SELECT 1 FROM broadcast_sessions b
              WHERE b.id = broadcast_id AND b.host_id = vc_current_user_id())
);
