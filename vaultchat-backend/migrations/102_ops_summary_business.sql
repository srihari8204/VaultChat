-- VaultChat: Business dashboard figures — tasks breakdown and this month's leave.
-- Idempotent — CREATE OR REPLACE, safe to re-run.
--
-- The Business Dashboard design adds a Tasks Summary (to do / overdue / done
-- today) and a Leave Summary (this month's requests by outcome). Both are
-- ordinary rows this server already stores, so they join space_ops_summary()
-- and ship in the SAME single payload the overview screen already fetches —
-- one request still renders the whole dashboard, and the Go route streams the
-- JSONB through with no struct to keep in step (see spaces_workforce.go).
--
-- The function body below is 089's, unchanged except for the two new keys.
-- The E2EE boundary is untouched: nothing here reads a position.

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

    -- ── tasks summary (Business design: TASKS SUMMARY card) ──
    -- open.tasks above stays the total of everything undone; this splits it.
    -- There is no "in progress" state in the model, so none is reported —
    -- a task is to do, overdue, or done.
    'tasks', (
      SELECT jsonb_build_object(
        'open',      COUNT(*) FILTER (WHERE done_at IS NULL
                                        AND (due_at IS NULL OR due_at >= NOW())),
        'overdue',   COUNT(*) FILTER (WHERE done_at IS NULL
                                        AND due_at IS NOT NULL AND due_at < NOW()),
        'doneToday', COUNT(*) FILTER (WHERE done_at::date = p_day)
      )
      FROM space_tasks WHERE chat_id = p_chat_id
    ),

    -- ── this month's leave (Business design: LEAVE SUMMARY card) ──
    -- The month containing p_day, by when the request was MADE. "declined"
    -- is the design's word for the stored status 'rejected'.
    'leaveMonth', (
      SELECT jsonb_build_object(
        'requests', COUNT(*),
        'pending',  COUNT(*) FILTER (WHERE status = 'pending'),
        'approved', COUNT(*) FILTER (WHERE status = 'approved'),
        'declined', COUNT(*) FILTER (WHERE status = 'rejected')
      )
      FROM space_leave
      WHERE chat_id = p_chat_id
        AND created_at::date >= date_trunc('month', p_day)::date
        AND created_at::date <  (date_trunc('month', p_day) + INTERVAL '1 month')::date
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
