-- VaultChat: Spaces & Operations — incidents, visitor passes, shift windows,
-- and the one alert the server can honestly raise.
-- Idempotent — safe to re-run.
--
-- ── the one alert ──
--
-- Overspeed, route deviation and long-stop are detected on the DRIVER'S DEVICE
-- and arrive as sealed alerts, because the server cannot read a position and we
-- are not going to give it one (see 086). Staleness is the exception, and the
-- exception is instructive: it is the ABSENCE of a ping, and absence needs no
-- plaintext. It is also the only one a device cannot self-report, because the
-- device is the thing that has gone.
--
-- So: runs carry a heartbeat, and "GPS offline" is derived from it.

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS last_ping_at TIMESTAMPTZ;

-- ── shift windows ───────────────────────────────────────────────────
-- Per space, on chats, because a shift belongs to the workplace and not to the
-- type. TIME rather than TIMESTAMPTZ: a shift is "09:00 local", every day, not
-- an instant. Attendance itself is DERIVED on device from the existing
-- safe-zone entry/exit events — these three columns are the only server-side
-- state the whole attendance feature needs.
ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS shift_start         TIME,
  ADD COLUMN IF NOT EXISTS shift_end           TIME,
  ADD COLUMN IF NOT EXISTS shift_grace_minutes INT NOT NULL DEFAULT 10;

-- ── incidents ───────────────────────────────────────────────────────
-- A breakdown, an accident, a road closure. Photographs are NOT stored here:
-- they go to the existing space album (encrypted), and this row carries the
-- reference. A second media path would be a second thing to encrypt correctly.
CREATE TABLE IF NOT EXISTS space_incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  run_id      UUID REFERENCES runs(id) ON DELETE SET NULL,
  reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  category    TEXT NOT NULL,
  -- Ciphertext. The server stores and forwards it and never reads it; only the
  -- CATEGORY is plaintext, which is what lets ops triage without the note.
  note        TEXT,
  media_ref   TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT space_incidents_category_check CHECK (category IN
    ('breakdown', 'accident', 'route_blocked', 'medical', 'behaviour', 'other')),
  CONSTRAINT space_incidents_status_check CHECK (status IN ('open', 'ack', 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_space_incidents_chat
  ON space_incidents(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_space_incidents_open
  ON space_incidents(chat_id) WHERE status <> 'resolved';

-- ── visitor passes ──────────────────────────────────────────────────
-- A visitor is NOT a member, and this table exists to keep it that way. It
-- borrows the shape of an invitation and deliberately not its table: redeeming
-- a pass grants entry to a building, never access to a space's members,
-- messages, runs or location.
CREATE TABLE IF NOT EXISTS visitor_passes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  host_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  visitor_name TEXT NOT NULL,
  code         TEXT NOT NULL,
  valid_from   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to     TIMESTAMPTZ NOT NULL,
  redeemed_at  TIMESTAMPTZ,
  exited_at    TIMESTAMPTZ,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT visitor_passes_window CHECK (valid_to > valid_from),
  CONSTRAINT visitor_passes_name_len CHECK (char_length(visitor_name) BETWEEN 1 AND 120)
);

-- The code is the credential, so it must be unique within a space while it can
-- still be used. Partial: an expired code may be reissued.
CREATE UNIQUE INDEX IF NOT EXISTS uq_visitor_passes_code
  ON visitor_passes(chat_id, code) WHERE redeemed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_visitor_passes_chat
  ON visitor_passes(chat_id, valid_to DESC);

-- ── row level security ──────────────────────────────────────────────
ALTER TABLE space_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_incidents FORCE  ROW LEVEL SECURITY;
ALTER TABLE visitor_passes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitor_passes  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS space_incidents_select ON space_incidents;
DROP POLICY IF EXISTS space_incidents_insert ON space_incidents;
DROP POLICY IF EXISTS space_incidents_update ON space_incidents;
DROP POLICY IF EXISTS visitor_passes_select  ON visitor_passes;
DROP POLICY IF EXISTS visitor_passes_write   ON visitor_passes;

-- Ops sees every incident; a reporter sees their own; anyone who can see the
-- RUN sees incidents on it — a parent whose child is on that bus has the
-- strongest possible claim to know it has broken down.
CREATE POLICY space_incidents_select ON space_incidents FOR SELECT USING (
  vc_is_chat_member(chat_id)
  AND (
    vc_space_ops_viewer(chat_id)
    OR reporter_id = vc_current_user_id()
    OR (run_id IS NOT NULL AND vc_run_visible(run_id))
  )
);
-- Filing is gated on the route by report_incident; the policy's job is to stop
-- a member filing one AS somebody else, in a space they are not in.
CREATE POLICY space_incidents_insert ON space_incidents FOR INSERT WITH CHECK (
  vc_is_chat_member(chat_id) AND reporter_id = vc_current_user_id()
);
-- Only ops closes an incident. A driver who could resolve their own breakdown
-- report could also make it disappear.
CREATE POLICY space_incidents_update ON space_incidents FOR UPDATE
  USING (vc_is_chat_member(chat_id) AND vc_space_ops_viewer(chat_id));

-- A pass is visible to ops and to its host. Not to the visitor: they hold the
-- code, which is the whole point of a code.
CREATE POLICY visitor_passes_select ON visitor_passes FOR SELECT USING (
  vc_is_chat_member(chat_id)
  AND (vc_space_ops_viewer(chat_id) OR host_id = vc_current_user_id())
);
CREATE POLICY visitor_passes_write ON visitor_passes FOR ALL
  USING (vc_is_chat_member(chat_id) AND vc_space_ops_viewer(chat_id))
  WITH CHECK (vc_is_chat_member(chat_id) AND vc_space_ops_viewer(chat_id));

-- ── NOT in this migration, on purpose ───────────────────────────────
-- No `announcement_audience` column. An announcement is already an ordinary
-- E2EE message carrying meta.announcement (see chats_helpers.go), and meta is
-- JSONB the server can read. The audience therefore rides in meta alongside the
-- flag, validated by the same server-side check. A column would duplicate a
-- field that already exists in a place the message spine already handles.
