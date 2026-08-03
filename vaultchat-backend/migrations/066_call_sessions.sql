-- 066_call_sessions.sql
-- Server-side call sessions and roles. Idempotent.
--
-- WHAT THIS FIXES
-- ---------------
-- There is no call on the server today. `callId` is just the chatId, which
-- means a chat can only ever have had ONE call: there is nothing to point a
-- recording at, no way to ask "who was on that call", and no second call to
-- distinguish from the first. Call history lives only on the device that made
-- the call (lib/callLog.ts, AsyncStorage, capped at 300 entries) — a reinstall
-- loses it and a second device never had it.
--
-- Roles are the other half. Webinar and broadcast need a host who can promote a
-- speaker and an audience that cannot publish, and that decision has to be made
-- somewhere the client can't reach. Putting the role here means the SFU's token
-- minting can read it (Phase C) and an audience token is subscribe-only because
-- the DB says so, not because the client asked nicely.
--
-- ADDITIVE ONLY. No existing table is altered and no existing query changes
-- meaning. The device-local call log keeps working exactly as it does today;
-- server history is a second source that the client merges, not a replacement.
--
-- CONTENT-FREE, like vb_transfer. This records that a call happened, between
-- whom, for how long, and in what role. It stores no media, no signalling, no
-- SDP and no in-call chat — those are E2EE and stay that way.

-- ── calls ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id       UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  -- Who started it. Kept even if they leave first — "started by" is history.
  started_by    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'audio',        -- audio | video
  -- mesh today; sfu when Phase C lands. Recorded per call so a mixed-fleet
  -- period is legible afterwards rather than guesswork.
  transport     TEXT NOT NULL DEFAULT 'mesh',         -- mesh | sfu
  -- meeting is the default; webinar/broadcast gate who may publish (Phase D/E).
  mode          TEXT NOT NULL DEFAULT 'meeting',      -- meeting | webinar | broadcast
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL means live. Every "is this call still going" query reads this.
  ended_at      TIMESTAMPTZ,
  end_reason    TEXT,
  CONSTRAINT calls_kind_ck      CHECK (kind      IN ('audio', 'video')),
  CONSTRAINT calls_transport_ck CHECK (transport IN ('mesh', 'sfu')),
  CONSTRAINT calls_mode_ck      CHECK (mode      IN ('meeting', 'webinar', 'broadcast'))
);

-- "What's live in this chat right now" — the join path's only lookup, and the
-- reason a second caller joins the existing call instead of starting a rival
-- one. Partial, so it indexes the handful of live calls and not the history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_live_per_chat
  ON calls (chat_id)
  WHERE ended_at IS NULL;

-- History lookups, newest first.
CREATE INDEX IF NOT EXISTS idx_calls_chat_started
  ON calls (chat_id, started_at DESC);

-- ── call_participants ───────────────────────────────────────
-- One row per (call, user). A user who drops and rejoins updates their row
-- rather than adding a second: "was Ann on this call, in what role, for how
-- long" has exactly one answer per call.
CREATE TABLE IF NOT EXISTS call_participants (
  call_id       UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- host   — started it; may promote, demote, remove and end the call
  -- cohost — may promote and demote; may not end the call
  -- speaker— may publish audio/video (the default in a meeting)
  -- audience—subscribe-only; the Phase-C token mint refuses publish grants
  role          TEXT NOT NULL DEFAULT 'speaker',
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at       TIMESTAMPTZ,
  -- Raise hand (B4). A timestamp rather than a boolean so the host's list
  -- orders by who asked first, which is the fair reading of a raised hand.
  hand_raised_at TIMESTAMPTZ,
  PRIMARY KEY (call_id, user_id),
  CONSTRAINT call_participants_role_ck
    CHECK (role IN ('host', 'cohost', 'speaker', 'audience'))
);

-- "Who is on this call now" — the roster read, on every join and leave.
CREATE INDEX IF NOT EXISTS idx_call_participants_live
  ON call_participants (call_id)
  WHERE left_at IS NULL;

-- "My call history across devices" — the B3 read, newest first.
CREATE INDEX IF NOT EXISTS idx_call_participants_user
  ON call_participants (user_id, joined_at DESC);

-- ── Helper: does the current user host this call? ───────────
-- SECURITY DEFINER so it reads call_participants WITHOUT re-entering that
-- table's RLS policy — see the note on call_participants_update below. Same
-- pattern and same reason as vc_is_chat_member in 004_rls.sql.
CREATE OR REPLACE FUNCTION vc_is_call_host(p_call_id UUID) RETURNS BOOLEAN AS $$
DECLARE
  uid UUID := vc_current_user_id();
BEGIN
  IF uid IS NULL THEN RETURN FALSE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM call_participants
    WHERE call_id = p_call_id AND user_id = uid AND left_at IS NULL
      AND role IN ('host', 'cohost')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ── RLS ─────────────────────────────────────────────────────
-- Same model as messages: visibility follows chat membership, and writes are
-- narrowed further. vc_is_chat_member / vc_current_user_id come from 004_rls.
--
-- Note what the policies deliberately do NOT do: they don't let a participant
-- change their own role. Promotion is a host action, and letting a row edit its
-- own `role` would hand every audience member a publish grant in Phase C. The
-- API enforces the host check, and the policy makes the DB refuse it too — the
-- one place a client can't argue with.

-- FORCE, not just ENABLE. ENABLE alone does nothing to the table's OWNER, and
-- if the app's role owns these tables (it owns the database in this repo's
-- setup) every policy below would be silently inert — a `USING (false)` policy
-- still returns rows to the owner. FORCE closes that, and costs nothing when
-- the owner is a different role. See scripts/check-rls.sql for how to tell
-- which case a given deployment is in; the existing tables are NOT changed here
-- because flipping them is a behaviour change that needs its own verification.
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calls_select ON calls;
DROP POLICY IF EXISTS calls_insert ON calls;
DROP POLICY IF EXISTS calls_update ON calls;

CREATE POLICY calls_select ON calls FOR SELECT USING (vc_is_chat_member(chat_id));
-- You may only open a call in a chat you're in, and only as yourself.
CREATE POLICY calls_insert ON calls FOR INSERT WITH CHECK (
  started_by = vc_current_user_id() AND vc_is_chat_member(chat_id)
);
-- Ending a call is the only update, and it is gated in the API to the host.
CREATE POLICY calls_update ON calls FOR UPDATE USING (vc_is_chat_member(chat_id));
-- No delete policy: call history is not deletable by a client. Retention is a
-- server-side sweep, not a user action.

ALTER TABLE call_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_participants FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_participants_select ON call_participants;
DROP POLICY IF EXISTS call_participants_insert ON call_participants;
DROP POLICY IF EXISTS call_participants_update ON call_participants;

-- See the roster of any call in a chat you're in.
CREATE POLICY call_participants_select ON call_participants FOR SELECT USING (
  EXISTS (SELECT 1 FROM calls c WHERE c.id = call_id AND vc_is_chat_member(c.chat_id))
);
-- Join as YOURSELF only. A host adding someone else is not a thing — you ring
-- them and they join.
CREATE POLICY call_participants_insert ON call_participants FOR INSERT WITH CHECK (
  user_id = vc_current_user_id()
  AND EXISTS (SELECT 1 FROM calls c WHERE c.id = call_id AND vc_is_chat_member(c.chat_id))
);
-- Update your own row (leave, raise hand), or any row if you host/cohost this
-- call (promote, demote, remove).
--
-- The host check MUST go through a SECURITY DEFINER function. Writing it inline
-- as `EXISTS (SELECT 1 FROM call_participants me WHERE ...)` makes the policy
-- query the very table it guards, which re-enters the policy: Postgres detects
-- it and fails EVERY update with "infinite recursion detected in policy". The
-- SQL is valid and the migration applies clean — it only breaks at runtime,
-- which is exactly why this is verified against a live database. Same reason
-- vc_is_chat_member exists in 004_rls.sql.
CREATE POLICY call_participants_update ON call_participants FOR UPDATE USING (
  user_id = vc_current_user_id() OR vc_is_call_host(call_id)
);

-- ── role changes are a HOST action, enforced in the database ──
--
-- The policy above lets you edit your OWN row — you have to, in order to leave
-- or raise your hand. But "edit your own row" would also let an audience member
-- set their own role to 'speaker', and in Phase C the role is what the SFU mints
-- a publish grant from. A policy cannot express "this column may not change",
-- because USING sees the old row and WITH CHECK sees the new one and neither can
-- see both. A trigger can.
--
-- A NULL current user means server-internal (a sweeper ending stale calls). It
-- is permitted here because FORCE ROW LEVEL SECURITY already denies such a
-- session every row — it can never reach this trigger with a client's data.
CREATE OR REPLACE FUNCTION vc_call_role_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     AND vc_current_user_id() IS NOT NULL
     AND NOT vc_is_call_host(NEW.call_id) THEN
    RAISE EXCEPTION 'only a host or cohost may change a call role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS call_participants_role_guard ON call_participants;
CREATE TRIGGER call_participants_role_guard
  BEFORE UPDATE ON call_participants
  FOR EACH ROW EXECUTE FUNCTION vc_call_role_guard();
