-- VaultChat: Spaces & Operations — workforce records and SERVER-SIDE dashboards.
-- Idempotent — safe to re-run.
--
-- Two things happen here, and the second is the point.
--
-- 1. The workforce tables the School and Employee designs need: an explicit
--    attendance record, leave requests, and assigned tasks.
--
-- 2. `space_ops_summary()` — one function that computes an ENTIRE dashboard and
--    returns it as a single JSONB payload.
--
-- ── why the dashboard is computed here and not on the phone ──
--
-- The rest of this change deliberately computes on-device, because LOCATION is
-- end-to-end encrypted and the server cannot read it. None of that applies to
-- operational data: a pickup count, a headcount, a leave balance and an
-- attendance percentage are ordinary rows this server already stores in the
-- clear. Recomputing them on every phone means every phone fetches the whole
-- manifest of every run to render six numbers.
--
-- So the school and workforce dashboards are SQL. The client asks one question
-- and renders the answer. That keeps the app thin — fewer round trips, less
-- code shipped in the APK, and a dashboard that cannot disagree between two
-- phones because there is only one implementation of it.
--
-- The E2EE boundary is unchanged: nothing here reads a position. Where a run is
-- still comes from the sealed ping, and this function never touches it.

-- ── explicit attendance ─────────────────────────────────────────────
-- The DESIGN's check-in is a button ("Check-Out Now", "I'm Safe"), not a
-- geofence inference — so it is a record of an action a person took, and it
-- belongs on the server where a manager can be shown it.
--
-- This does NOT replace the geofence projection in lib/spaces/attendance.ts.
-- That one answers "was their phone at the office", derived on a device that
-- may see location; this one answers "did they say they had arrived". They are
-- different claims and a workplace usually wants both.
CREATE TABLE IF NOT EXISTS space_attendance (
  id           BIGSERIAL PRIMARY KEY,
  chat_id      UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          DATE NOT NULL,
  check_in_at  TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  -- 'self' = they tapped it. 'geofence' = a device-side crossing was promoted
  -- to a record. Kept apart so a report can say which it is trusting.
  source       TEXT NOT NULL DEFAULT 'self',
  note         TEXT,
  UNIQUE (chat_id, user_id, day),
  CONSTRAINT space_attendance_source_check CHECK (source IN ('self', 'geofence', 'admin')),
  CONSTRAINT space_attendance_order CHECK (check_out_at IS NULL OR check_in_at IS NULL OR check_out_at >= check_in_at)
);

CREATE INDEX IF NOT EXISTS idx_space_attendance_day ON space_attendance(chat_id, day);

-- ── leave ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS space_leave (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'casual',
  from_day    DATE NOT NULL,
  to_day      DATE NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  decided_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT space_leave_kind_check CHECK (kind IN ('casual', 'sick', 'privilege', 'unpaid', 'other')),
  CONSTRAINT space_leave_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  -- A range that ends before it starts is not a request, it is a typo.
  CONSTRAINT space_leave_range CHECK (to_day >= from_day)
);

CREATE INDEX IF NOT EXISTS idx_space_leave_chat ON space_leave(chat_id, from_day, to_day);
CREATE INDEX IF NOT EXISTS idx_space_leave_pending ON space_leave(chat_id) WHERE status = 'pending';

-- ── assigned tasks ──────────────────────────────────────────────────
-- Distinct from the E2EE group tasks (G4.1), which are a fold over encrypted
-- messages and are the right model for a household. A workplace task is
-- ASSIGNED BY someone to someone, and a manager has to be able to see the list
-- without being handed everyone's keys — so it is a row.
CREATE TABLE IF NOT EXISTS space_tasks (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  priority    TEXT NOT NULL DEFAULT 'medium',
  due_at      TIMESTAMPTZ,
  done_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT space_tasks_priority_check CHECK (priority IN ('low', 'medium', 'high')),
  CONSTRAINT space_tasks_title_len CHECK (char_length(title) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_space_tasks_assignee ON space_tasks(chat_id, assignee_id) WHERE done_at IS NULL;

-- ── row level security ──────────────────────────────────────────────
ALTER TABLE space_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_attendance FORCE  ROW LEVEL SECURITY;
ALTER TABLE space_leave      ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_leave      FORCE  ROW LEVEL SECURITY;
ALTER TABLE space_tasks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_tasks      FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS space_attendance_select ON space_attendance;
DROP POLICY IF EXISTS space_attendance_write  ON space_attendance;
DROP POLICY IF EXISTS space_leave_select      ON space_leave;
DROP POLICY IF EXISTS space_leave_insert      ON space_leave;
DROP POLICY IF EXISTS space_leave_update      ON space_leave;
DROP POLICY IF EXISTS space_tasks_select      ON space_tasks;
DROP POLICY IF EXISTS space_tasks_write       ON space_tasks;

-- Your own record always; everyone's if you run the space. A supervisor sees
-- their line through the route, which resolves space_links — the same rule the
-- rest of this change uses, not a second one.
CREATE POLICY space_attendance_select ON space_attendance FOR SELECT USING (
  vc_is_chat_member(chat_id)
  AND (user_id = vc_current_user_id() OR vc_space_ops_viewer(chat_id))
);
-- You may only write YOUR OWN attendance. A check-in is a statement about where
-- you are; letting anyone file it for someone else makes the record worthless.
CREATE POLICY space_attendance_write ON space_attendance FOR ALL
  USING (vc_is_chat_member(chat_id) AND user_id = vc_current_user_id())
  WITH CHECK (vc_is_chat_member(chat_id) AND user_id = vc_current_user_id());

CREATE POLICY space_leave_select ON space_leave FOR SELECT USING (
  vc_is_chat_member(chat_id)
  AND (user_id = vc_current_user_id() OR vc_space_ops_viewer(chat_id))
);
-- Request leave for yourself only.
CREATE POLICY space_leave_insert ON space_leave FOR INSERT WITH CHECK (
  vc_is_chat_member(chat_id) AND user_id = vc_current_user_id()
);
-- Deciding is an ops act; withdrawing your own is not. Both land here, and the
-- route separates which transition each may make.
CREATE POLICY space_leave_update ON space_leave FOR UPDATE USING (
  vc_is_chat_member(chat_id)
  AND (vc_space_ops_viewer(chat_id) OR user_id = vc_current_user_id())
);

CREATE POLICY space_tasks_select ON space_tasks FOR SELECT USING (
  vc_is_chat_member(chat_id)
  AND (assignee_id = vc_current_user_id() OR assigned_by = vc_current_user_id() OR vc_space_ops_viewer(chat_id))
);
CREATE POLICY space_tasks_write ON space_tasks FOR ALL
  USING (
    vc_is_chat_member(chat_id)
    AND (vc_space_ops_viewer(chat_id) OR assignee_id = vc_current_user_id())
  )
  WITH CHECK (
    vc_is_chat_member(chat_id)
    AND (vc_space_ops_viewer(chat_id) OR assignee_id = vc_current_user_id())
  );

-- ── THE DASHBOARD, COMPUTED HERE ────────────────────────────────────
--
-- Returns everything the School Overview and Employee Dashboard designs show,
-- in one JSONB payload, for one day.
--
-- SECURITY DEFINER with a hard membership gate on the first line. It aggregates
-- across the whole space, which is exactly what an ops viewer is entitled to and
-- exactly what nobody else is — so the gate is the whole safety of it, and the
-- caller is checked before a single count is taken.
--
-- Note what is NOT in here: no position, no path, no coordinate. Where a bus is
-- remains the sealed ping the server cannot read. This answers "how many, how
-- far through, how many still waiting" — which is what an office actually puts
-- on a wall.
CREATE OR REPLACE FUNCTION space_ops_summary(
  p_chat_id UUID,
  p_viewer  UUID,
  p_day     DATE DEFAULT CURRENT_DATE
) RETURNS JSONB
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  is_ops   BOOLEAN;
  gtype    TEXT;
  out_json JSONB;
BEGIN
  -- Gate first. Everything below reads the whole space.
  SELECT EXISTS (
    SELECT 1 FROM chat_members
     WHERE chat_id = p_chat_id AND user_id = p_viewer AND left_at IS NULL
       AND role IN ('moderator', 'admin', 'owner')
  ) INTO is_ops;
  IF NOT is_ops THEN
    RETURN jsonb_build_object('error', 'not_permitted');
  END IF;

  SELECT group_type INTO gtype FROM chats WHERE id = p_chat_id;

  SELECT jsonb_build_object(
    'day', p_day,
    'groupType', gtype,

    -- ── transport: runs and riders for the day ──
    'transport', (
      SELECT jsonb_build_object(
        'totalRuns',   COUNT(*),
        'active',      COUNT(*) FILTER (WHERE r.status = 'started'),
        'scheduled',   COUNT(*) FILTER (WHERE r.status = 'scheduled'),
        'completed',   COUNT(*) FILTER (WHERE r.status = 'completed'),
        -- "Delayed" is the server's own staleness verdict, not a guess: an
        -- active run that has stopped reporting. A run that never started is
        -- never delayed — see the same rule in lib/spaces/dashboard.ts.
        'notReporting', COUNT(*) FILTER (
          WHERE r.status = 'started'
            AND (r.last_ping_at IS NULL OR r.last_ping_at < NOW() - INTERVAL '3 minutes')
        )
      )
      FROM runs r
      WHERE r.chat_id = p_chat_id
        AND (r.scheduled_at::date = p_day OR r.started_at::date = p_day
             OR (r.scheduled_at IS NULL AND r.created_at::date = p_day))
    ),

    -- ── riders: the pickup/drop counts a school actually asks for ──
    'riders', (
      SELECT jsonb_build_object(
        'expected',  COUNT(*) FILTER (WHERE rr.state <> 'cancelled'),
        'picked',    COUNT(*) FILTER (WHERE rr.state = 'boarded'),
        'dropped',   COUNT(*) FILTER (WHERE rr.state = 'dropped'),
        'pending',   COUNT(*) FILTER (WHERE rr.state = 'pending'),
        'absent',    COUNT(*) FILTER (WHERE rr.state IN ('absent', 'no_show')),
        -- Pending on a run that has FINISHED: nobody marked them either way, so
        -- the record cannot say whether they travelled. Never folded into
        -- absent — it is the one number that means "go and look for someone".
        'unaccounted', COUNT(*) FILTER (
          WHERE rr.state = 'pending' AND r.status IN ('completed', 'cancelled')
        )
      )
      FROM run_riders rr
      JOIN runs r ON r.id = rr.run_id
      WHERE r.chat_id = p_chat_id
        AND (r.scheduled_at::date = p_day OR r.started_at::date = p_day
             OR (r.scheduled_at IS NULL AND r.created_at::date = p_day))
    ),

    -- ── roster ──
    'roster', (
      SELECT jsonb_build_object(
        'total',    COUNT(*),
        'children', COUNT(*) FILTER (WHERE kind = 'child'),
        'linked',   COUNT(*) FILTER (WHERE user_id IS NOT NULL)
      )
      FROM space_roster WHERE chat_id = p_chat_id AND archived_at IS NULL
    ),

    -- ── workforce: headcount, attendance, leave ──
    'workforce', (
      SELECT jsonb_build_object(
        'members',   (SELECT COUNT(*) FROM chat_members WHERE chat_id = p_chat_id AND left_at IS NULL),
        'checkedIn', (SELECT COUNT(*) FROM space_attendance
                       WHERE chat_id = p_chat_id AND day = p_day AND check_in_at IS NOT NULL),
        'stillIn',   (SELECT COUNT(*) FROM space_attendance
                       WHERE chat_id = p_chat_id AND day = p_day
                         AND check_in_at IS NOT NULL AND check_out_at IS NULL),
        'onLeave',   (SELECT COUNT(*) FROM space_leave
                       WHERE chat_id = p_chat_id AND status = 'approved'
                         AND p_day BETWEEN from_day AND to_day),
        'leavePending', (SELECT COUNT(*) FROM space_leave
                          WHERE chat_id = p_chat_id AND status = 'pending'),
        -- Late needs a shift to compare against. With none configured the
        -- honest answer is NULL, not zero — "0 late" and "we do not know" are
        -- different statements and only one of them is true here.
        'lateToday', (
          SELECT CASE WHEN c.shift_start IS NULL THEN NULL ELSE COUNT(*) END
            FROM chats c
            LEFT JOIN space_attendance a
              ON a.chat_id = c.id AND a.day = p_day AND a.check_in_at IS NOT NULL
             AND a.check_in_at::time > (c.shift_start + make_interval(mins => c.shift_grace_minutes))
           WHERE c.id = p_chat_id
           GROUP BY c.shift_start
        )
      )
    ),

    -- ── open work ──
    'open', (
      SELECT jsonb_build_object(
        'incidents', (SELECT COUNT(*) FROM space_incidents
                       WHERE chat_id = p_chat_id AND status <> 'resolved'),
        'sos',       (SELECT COUNT(*) FROM space_incidents
                       WHERE chat_id = p_chat_id AND status <> 'resolved' AND category = 'sos'),
        'tasks',     (SELECT COUNT(*) FROM space_tasks
                       WHERE chat_id = p_chat_id AND done_at IS NULL),
        'visitors',  (SELECT COUNT(*) FROM visitor_passes
                       WHERE chat_id = p_chat_id AND redeemed_at IS NOT NULL AND exited_at IS NULL)
      )
    ),

    -- ── the live run list the design puts under the tiles ──
    -- Bounded at 50: a dashboard is a summary, and a school with more buses
    -- than that needs a list screen, not a longer card.
    'runs', COALESCE((
      SELECT jsonb_agg(x ORDER BY x->>'name')
        FROM (
          SELECT jsonb_build_object(
            'id', r.id,
            'name', COALESCE(r.vehicle_label, r.name),
            'status', r.status,
            'stale', r.status = 'started'
                     AND (r.last_ping_at IS NULL OR r.last_ping_at < NOW() - INTERVAL '3 minutes'),
            'total',   (SELECT COUNT(*) FROM run_riders q WHERE q.run_id = r.id AND q.state <> 'cancelled'),
            'pending', (SELECT COUNT(*) FROM run_riders q WHERE q.run_id = r.id AND q.state = 'pending')
          ) AS x
          FROM runs r
          WHERE r.chat_id = p_chat_id AND r.status IN ('scheduled', 'started')
          LIMIT 50
        ) s
    ), '[]'::jsonb)
  ) INTO out_json;

  RETURN out_json;
END;
$$ LANGUAGE plpgsql STABLE;
