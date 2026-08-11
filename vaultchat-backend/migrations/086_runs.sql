-- VaultChat: Spaces & Operations — the run engine.
-- Idempotent — safe to re-run.
--
-- ONE engine for every scheduled multi-stop trip. A school bus route, a school
-- drop, an office cab shuttle and a generic group trip differ in CONFIGURATION
-- (who rides, who is notified, whether handover needs a code), not in structure:
-- all four are a driver, an ordered list of stops, and a manifest of people
-- expected at those stops.
--
-- Rejected: bus_routes + bus_students + cab_trips + cab_employees. Four tables,
-- four sets of endpoints, four screens, one behaviour — and the school code
-- would inevitably grow a fix the cab code never got.
--
-- ── what is NOT here ──
--
-- No coordinates for vehicles or people. A run's live position is the driver
-- device's ordinary sealed location ping tagged with the run id; the server
-- neither stores nor can read it. run_events records STATE TRANSITIONS with
-- timestamps — boarded, dropped, absent, arrived at stop — which is what a
-- manifest and a replay actually need. Stop coordinates ARE stored, because a
-- stop is a fixed published place, not a person; the row that binds a person to
-- a place is run_riders, and that is scoped by the visibility rule from 085.

-- ── runs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id       UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'generic',
  name          TEXT NOT NULL,
  -- The driver is a USER (they carry the phone that emits the position), unlike
  -- riders, who are roster entries and may have no account at all.
  driver_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  vehicle_label TEXT,
  scheduled_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'scheduled',
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  -- Handover verification, per run, off unless the space turns it on. A real
  -- safety feature for young children and pure friction everywhere else.
  require_code  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runs_kind_check CHECK (kind IN
    ('school_pickup', 'school_drop', 'cab_pickup', 'cab_drop', 'generic')),
  CONSTRAINT runs_status_check CHECK (status IN
    ('scheduled', 'started', 'completed', 'cancelled')),
  CONSTRAINT runs_name_len CHECK (char_length(name) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS idx_runs_chat_status ON runs(chat_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_runs_driver ON runs(driver_id) WHERE status = 'started';

-- One active run per driver. A person cannot be driving two vehicles, and
-- allowing it would make "which run is this ping for?" ambiguous exactly when it
-- matters. Enforced by a unique index rather than a handler check, because two
-- concurrent starts would both pass an application-level test.
CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_one_active_driver
  ON runs(driver_id) WHERE status = 'started' AND driver_id IS NOT NULL;

-- ── lifecycle, enforced in the database ─────────────────────────────
-- scheduled → started → completed, with cancelled reachable from the first two.
-- In the DATABASE and not only the route: a run that jumps to completed without
-- ever starting produces a manifest nobody can explain, and the handler is not
-- the only thing that will ever write this column.
CREATE OR REPLACE FUNCTION runs_guard_status() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'scheduled' AND NEW.status IN ('started', 'cancelled'))
    OR (OLD.status = 'started'   AND NEW.status IN ('completed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'run_status_transition_invalid: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Stamp the timestamps here rather than trusting the caller: they are the
  -- evidence a replay is built from, and a client-supplied "started_at" is a
  -- client-supplied fact about when a bus left.
  IF NEW.status = 'started' THEN
    NEW.started_at := COALESCE(NEW.started_at, NOW());
  ELSIF NEW.status IN ('completed', 'cancelled') THEN
    NEW.completed_at := COALESCE(NEW.completed_at, NOW());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_runs_guard_status ON runs;
CREATE TRIGGER trg_runs_guard_status BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_guard_status();

-- ── stops ───────────────────────────────────────────────────────────
-- A stop is a PLACE, and carries no rider identity. That separation is what
-- lets the stop list be readable by anyone on the run while the manifest stays
-- scoped: knowing the bus stops on Green Lane tells you nothing about who lives
-- there.
CREATE TABLE IF NOT EXISTS run_stops (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INT  NOT NULL,
  label      TEXT NOT NULL,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  planned_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ,
  UNIQUE (run_id, seq),
  CONSTRAINT run_stops_latlng CHECK (
    (lat IS NULL AND lng IS NULL)
    OR (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)
  )
);

-- ── the manifest ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS run_riders (
  run_id    UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  rider_id  UUID NOT NULL REFERENCES space_roster(id) ON DELETE CASCADE,
  stop_id   UUID REFERENCES run_stops(id) ON DELETE SET NULL,
  state     TEXT NOT NULL DEFAULT 'pending',
  state_at  TIMESTAMPTZ,
  actor_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  note      TEXT,
  PRIMARY KEY (run_id, rider_id),
  CONSTRAINT run_riders_state_check CHECK (state IN
    ('pending', 'boarded', 'dropped', 'absent', 'no_show', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_run_riders_rider ON run_riders(rider_id);

-- ── the event log ───────────────────────────────────────────────────
-- Append-only, and the source of truth for dashboards, notifications and
-- replay. Nothing derived from it is stored: a count that can be recomputed and
-- a count that is cached are two things that can disagree.
CREATE TABLE IF NOT EXISTS run_events (
  id            BIGSERIAL PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  ref_id        UUID,
  actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail        JSONB,
  -- Client-supplied idempotency key. A driver marking a child boarded on a
  -- flaky bus connection WILL retry, and two boarding events for one child make
  -- the manifest a story rather than a record.
  transition_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_run_events_transition
  ON run_events(run_id, transition_id) WHERE transition_id IS NOT NULL;

-- ── driver duty state ───────────────────────────────────────────────
-- Per SPACE, not per user: someone can be an off-duty driver at the school and
-- an ordinary parent at the sports club. NULL means "not a driver / not stated",
-- which is every existing member.
ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS duty_state TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'chat_members'::regclass AND conname = 'chat_members_duty_check'
  ) THEN
    ALTER TABLE chat_members ADD CONSTRAINT chat_members_duty_check
      CHECK (duty_state IS NULL OR duty_state IN ('on_duty', 'on_break', 'off_duty'));
  END IF;
END $$;

-- ── handover code ───────────────────────────────────────────────────
-- Opt-in per run (runs.require_code). The code lives on the roster entry because
-- it belongs to the CHILD, not to one journey — a parent should not have to
-- learn a new PIN every morning.
--
-- Stored in the clear, deliberately. It is a 4-digit handover PIN shown to the
-- guardian and typed by the driver, readable only by people who can already see
-- that child's whole record. Hashing it would defend against nobody in the
-- threat model while making "remind me of my code" impossible.
ALTER TABLE space_roster
  ADD COLUMN IF NOT EXISTS handover_code TEXT;

-- ── visibility ──────────────────────────────────────────────────────
-- SECURITY DEFINER, and it must be: the policies on runs and run_riders would
-- otherwise reference each other's tables and recurse. Definer rights let the
-- helper answer the question once, from outside both policies.
--
-- You may see a run if you run the space, you drive it, or one of its riders is
-- someone you may see. That last clause is the whole point — a parent gets the
-- bus their child is on, and nothing else on the timetable.
CREATE OR REPLACE FUNCTION vc_run_visible(p_run_id UUID) RETURNS BOOLEAN
SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM runs r
     WHERE r.id = p_run_id
       AND (
         r.driver_id = vc_current_user_id()
         OR vc_space_ops_viewer(r.chat_id)
         OR EXISTS (
           SELECT 1 FROM run_riders rr
            WHERE rr.run_id = r.id
              AND space_can_view_roster(r.chat_id, vc_current_user_id(), rr.rider_id)
         )
       )
  );
$$ LANGUAGE sql STABLE;

ALTER TABLE runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs       FORCE  ROW LEVEL SECURITY;
ALTER TABLE run_stops  ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_stops  FORCE  ROW LEVEL SECURITY;
ALTER TABLE run_riders ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_riders FORCE  ROW LEVEL SECURITY;
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS runs_select       ON runs;
DROP POLICY IF EXISTS runs_write        ON runs;
DROP POLICY IF EXISTS run_stops_select  ON run_stops;
DROP POLICY IF EXISTS run_stops_write   ON run_stops;
DROP POLICY IF EXISTS run_riders_select ON run_riders;
DROP POLICY IF EXISTS run_riders_write  ON run_riders;
DROP POLICY IF EXISTS run_events_select ON run_events;
DROP POLICY IF EXISTS run_events_insert ON run_events;

CREATE POLICY runs_select ON runs FOR SELECT USING (
  vc_is_chat_member(chat_id) AND vc_run_visible(id)
);
-- Building the timetable is an ops action. A driver may UPDATE their own run's
-- status (start it, complete it) — the transition guard above constrains what
-- that update can say, and the route checks drive_run.
CREATE POLICY runs_write ON runs FOR ALL
  USING (
    vc_is_chat_member(chat_id)
    AND (vc_space_ops_viewer(chat_id) OR driver_id = vc_current_user_id())
  )
  WITH CHECK (
    vc_is_chat_member(chat_id)
    AND (vc_space_ops_viewer(chat_id) OR driver_id = vc_current_user_id())
  );

-- Stops travel with the run: if you can see the run, you can see where it goes.
CREATE POLICY run_stops_select ON run_stops FOR SELECT USING (vc_run_visible(run_id));
CREATE POLICY run_stops_write ON run_stops FOR ALL
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND vc_space_ops_viewer(r.chat_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND vc_space_ops_viewer(r.chat_id)));

-- The manifest is scoped PER RIDER, not per run. A parent who can see the run
-- still sees only their own child's row on it — this is the line that stops the
-- bus screen from being a roster of every child at the stop.
CREATE POLICY run_riders_select ON run_riders FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM runs r
     WHERE r.id = run_id
       AND (
         r.driver_id = vc_current_user_id()
         OR vc_space_ops_viewer(r.chat_id)
         OR space_can_view_roster(r.chat_id, vc_current_user_id(), rider_id)
       )
  )
);
-- Ops builds the manifest; the driver marks it. Both are constrained further by
-- the route (manage_runs / drive_run) and by the state CHECK.
CREATE POLICY run_riders_write ON run_riders FOR ALL
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id
      AND (vc_space_ops_viewer(r.chat_id) OR r.driver_id = vc_current_user_id())))
  WITH CHECK (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id
      AND (vc_space_ops_viewer(r.chat_id) OR r.driver_id = vc_current_user_id())));

CREATE POLICY run_events_select ON run_events FOR SELECT USING (vc_run_visible(run_id));
-- Append-only for clients: an INSERT policy and deliberately no UPDATE or
-- DELETE policy, so the log cannot be rewritten by anyone the app authenticates.
CREATE POLICY run_events_insert ON run_events FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id
      AND (vc_space_ops_viewer(r.chat_id) OR r.driver_id = vc_current_user_id())
  )
);
