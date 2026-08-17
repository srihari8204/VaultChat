-- 105_golive_visibility.sql — Public vs Private Go Live, and host presence.
-- Idempotent.
--
-- WHAT WAS MISSING
-- ----------------
-- Every broadcast was public. 079's SELECT policy is `USING (TRUE)` and nothing
-- in broadcasts.go consulted an audience list, so "Private Live" did not exist
-- as a concept: any authenticated account could list any stream, mint a viewer
-- token for it, and be handed a playback ticket. broadcast_invites (082) already
-- recorded WHO was invited, but it only affected whether someone could PUBLISH
-- (the co-host path in broadcastToken) — never whether they could WATCH.
--
-- visibility is that missing gate, and it is a column rather than a separate
-- table because it is exactly one fact per session with no history to keep.
--
-- 'public' IS THE DEFAULT ON PURPOSE
-- ----------------------------------
-- Existing rows are public and were created under a public contract; back-filling
-- them to 'private' would retroactively hide streams whose hosts believed they
-- were open, and it would strand the ended-history the app already lists.
--
-- HOST PRESENCE
-- -------------
-- host_left_at is the grace-period clock for a host who disconnects. It is a
-- COLUMN and not an in-memory timer for one reason: a timer dies with the
-- process, and the case this exists for — a host whose app was killed — is
-- exactly the case that coincides with backend restarts and deploys. A timestamp
-- in the row survives both, so the sweep (routes/golive_reaper.go) reaches the
-- same verdict whether or not the API stayed up.
--
-- NULL means "the host is present, or has never joined". A value means "the host
-- left at this instant and has not come back".

ALTER TABLE broadcast_sessions
  ADD COLUMN IF NOT EXISTS visibility   TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS host_left_at TIMESTAMPTZ;

-- Added separately from the column so re-running is safe: ADD COLUMN IF NOT
-- EXISTS skips its inline CHECK on a second run, which would leave the
-- constraint absent on any database that already had the column.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'broadcast_sessions_visibility_ck') THEN
    ALTER TABLE broadcast_sessions
      ADD CONSTRAINT broadcast_sessions_visibility_ck
      CHECK (visibility IN ('public', 'private'));
  END IF;
END $$;

-- Discovery lists PUBLIC live streams; the private ones are found through an
-- invitation, never a listing. Partial index so the listing query stays
-- independent of how much private and ended history accumulates.
CREATE INDEX IF NOT EXISTS broadcast_sessions_public_live_idx
  ON broadcast_sessions (started_at DESC)
  WHERE status = 'live' AND visibility = 'public';

-- The reaper's predicate. Tiny partial index; matches nothing on a healthy
-- system, which is the point.
CREATE INDEX IF NOT EXISTS broadcast_sessions_host_gone_idx
  ON broadcast_sessions (host_left_at)
  WHERE host_left_at IS NOT NULL AND status IN ('starting', 'live');

-- ── RLS: private streams are readable only by host and invitee ─────────
--
-- This REPLACES 079's `USING (TRUE)`, which is the only thing here that touches
-- existing policy. It has to: a policy that allows every row cannot express
-- "private". Public rows behave exactly as before, so nothing that worked stops
-- working.
--
-- RLS is the second gate, not the only one. docs/RLS_ENFORCEMENT.md records that
-- this deployment's API role can bypass policies, so routes/golive.go performs
-- the SAME check in Go. Either gate alone is sufficient; both is the rule the
-- rest of this codebase already follows (call_sessions.go, broadcastSetHLS).
DROP POLICY IF EXISTS broadcast_sessions_select ON broadcast_sessions;
CREATE POLICY broadcast_sessions_select ON broadcast_sessions FOR SELECT USING (
  visibility = 'public'
  OR host_id = vc_current_user_id()
  OR EXISTS (
    SELECT 1 FROM broadcast_invites i
     WHERE i.broadcast_id = broadcast_sessions.id
       AND i.invitee_id = vc_current_user_id()
  )
);

-- Chat follows the stream it belongs to: if you cannot watch a private
-- broadcast, you cannot read or post in it either. Without this, the transcript
-- of a private stream stayed world-readable through /broadcasts/{id}/chat.
DROP POLICY IF EXISTS broadcast_chat_select ON broadcast_chat;
CREATE POLICY broadcast_chat_select ON broadcast_chat FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM broadcast_sessions b
     WHERE b.id = broadcast_chat.broadcast_id
       AND (b.visibility = 'public'
            OR b.host_id = vc_current_user_id()
            OR EXISTS (SELECT 1 FROM broadcast_invites i
                        WHERE i.broadcast_id = b.id
                          AND i.invitee_id = vc_current_user_id()))
  )
);

DROP POLICY IF EXISTS broadcast_chat_insert ON broadcast_chat;
CREATE POLICY broadcast_chat_insert ON broadcast_chat FOR INSERT WITH CHECK (
  user_id = vc_current_user_id()
  AND EXISTS (
    SELECT 1 FROM broadcast_sessions b
     WHERE b.id = broadcast_id
       AND b.status = 'live'
       AND (b.visibility = 'public'
            OR b.host_id = vc_current_user_id()
            OR EXISTS (SELECT 1 FROM broadcast_invites i
                        WHERE i.broadcast_id = b.id
                          AND i.invitee_id = vc_current_user_id()))
  )
);
