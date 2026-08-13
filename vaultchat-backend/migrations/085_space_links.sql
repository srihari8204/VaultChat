-- VaultChat: Spaces & Operations — the ops roster and the visibility edge.
-- Idempotent — safe to re-run.
--
-- This migration carries the single most sensitive rule in the change: a parent
-- must see their own child and no other child. Everything else here exists to
-- make that rule ONE rule rather than one per screen.
--
-- ── why a roster at all, when chats already have members ──
--
-- Two reasons, and the first is not negotiable.
--
-- 1. A six-year-old does not have a VaultChat account. The people a school
--    tracks are largely not users, so a model keyed on users cannot express the
--    roster at all.
-- 2. Chat membership is MUTUAL DISCLOSURE and must stay that way. Everyone in a
--    chat can see who else is in it — that is what being in a chat means, and
--    hiding senders would break message attribution, mentions and read
--    receipts. Scoping chat_members would therefore fight the whole product.
--
-- So the ops model is a SEPARATE roster: space_roster. Staff and parents have
-- roster entries linked to their user accounts (they are also chat members, and
-- still see each other in chat, exactly as before). Children have roster entries
-- with no account. The privacy claim is about the ROSTER and the RIDER records —
-- the things that say where a named child physically is — and those are new
-- surfaces with no legacy visibility to preserve.
--
-- ── why one edge table ──
--
-- parent → child, supervisor → employee, manager → department are the same
-- shape. One table and one resolver means "message my department" and "see my
-- department" cannot disagree, because they call the same function.

-- ── the roster ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS space_roster (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  -- NULL for a roster entry with no account: a young child, a pet, a contractor
  -- who never installs the app. Set for staff, parents and employees.
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'person',
  -- The organisation's own identifier — a student number, an employee code. Kept
  -- so an import can be re-run without duplicating people.
  external_ref TEXT,
  -- Soft archive. A child who leaves the school must vanish from every live view
  -- while their historical run records stay attributable.
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT space_roster_name_len CHECK (char_length(display_name) BETWEEN 1 AND 120)
);

-- One roster entry per account per space. Without this a person imported twice
-- has two entries, and a link to the wrong one silently shows nothing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_space_roster_user
  ON space_roster(chat_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_space_roster_extref
  ON space_roster(chat_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_roster_chat
  ON space_roster(chat_id) WHERE archived_at IS NULL;

-- ── the edge ────────────────────────────────────────────────────────
-- Directed: subject sees object. Both ends are roster entries, never users, so
-- the parent→child case (object has no account) and the supervisor→employee
-- case (object does) are the same row shape and need no polymorphism.
CREATE TABLE IF NOT EXISTS space_links (
  chat_id    UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES space_roster(id) ON DELETE CASCADE,
  object_id  UUID NOT NULL REFERENCES space_roster(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (chat_id, subject_id, object_id, relation),
  CONSTRAINT space_links_relation_check
    CHECK (relation IN ('guardian_of', 'supervises', 'teaches')),
  -- A self-link is either a mistake or an attempt to confuse the resolver.
  CONSTRAINT space_links_no_self CHECK (subject_id <> object_id)
);

CREATE INDEX IF NOT EXISTS idx_space_links_subject ON space_links(chat_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_space_links_object  ON space_links(chat_id, object_id);

-- ── the resolver ────────────────────────────────────────────────────
-- ONE implementation, in SQL, because both the Go server and the Node server
-- need it and a second copy is a second answer to "who may this person see".
--
-- Returns the viewer's own roster entry plus everything reachable from it, with
-- depth. `truncated` is TRUE when the walk stopped at the depth bound with edges
-- still leading outward — the caller MUST surface that rather than presenting a
-- partial subtree as complete. A supervisor silently missing half their team is
-- worse than one told the hierarchy is too deep.
--
-- The depth bound is also the cycle guard: a link cycle cannot loop forever
-- because the recursion cannot exceed max_depth. That is why there is no CYCLE
-- clause here — the bound already does the job, and one mechanism is easier to
-- reason about than two.
--
-- ponytail: bounded at 6 with no materialised closure. A space is one campus or
-- one office, not a graph database. Add a closure table only if the CTE shows up
-- in query timings against real data.
-- SECURITY DEFINER is REQUIRED, not stylistic. This function is called from the
-- RLS policy on space_roster, and it reads space_roster. An INVOKER-rights
-- function would re-enter that policy on every row of its own walk — infinite
-- recursion, and Postgres reports it as a confusing "infinite recursion detected
-- in policy" at query time rather than at migration time. Definer rights break
-- the loop. search_path is pinned because a definer function that resolves
-- unqualified names through a caller-controlled path is a privilege-escalation
-- hole.
CREATE OR REPLACE FUNCTION space_visible_roster(
  p_chat_id   UUID,
  p_viewer    UUID,
  p_max_depth INT DEFAULT 6
) RETURNS TABLE (roster_id UUID, depth INT, truncated BOOLEAN)
SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH RECURSIVE me AS (
    SELECT r.id
      FROM space_roster r
     WHERE r.chat_id = p_chat_id
       AND r.user_id = p_viewer
       AND r.archived_at IS NULL
  ),
  walk AS (
    SELECT me.id AS roster_id, 0 AS depth FROM me
    UNION
    SELECT l.object_id, w.depth + 1
      FROM walk w
      JOIN space_links l ON l.chat_id = p_chat_id AND l.subject_id = w.roster_id
      JOIN space_roster r ON r.id = l.object_id AND r.archived_at IS NULL
     WHERE w.depth < p_max_depth
  )
  SELECT w.roster_id, w.depth,
         EXISTS (
           SELECT 1 FROM walk w2
             JOIN space_links l2 ON l2.chat_id = p_chat_id AND l2.subject_id = w2.roster_id
            WHERE w2.depth = p_max_depth
         ) AS truncated
    FROM walk w;
$$ LANGUAGE sql STABLE;

-- Convenience predicate for the hot path: may this viewer see this one roster
-- entry? Written as its own function so a route never hand-rolls the join and
-- accidentally omits the archived_at filter.
CREATE OR REPLACE FUNCTION space_can_view_roster(
  p_chat_id UUID,
  p_viewer  UUID,
  p_target  UUID
) RETURNS BOOLEAN
SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM space_visible_roster(p_chat_id, p_viewer) v
     WHERE v.roster_id = p_target
  );
$$ LANGUAGE sql STABLE;

-- Does the caller hold the space-wide view?
--
-- RANK, not the resolved permission. Resolving view_space_ops properly means
-- reimplementing the four-layer model in PL/pgSQL, and a second implementation
-- of the permission model is precisely the drift internal/groups exists to
-- prevent — a SQL copy nobody runs mirrorcheck against would rot silently.
--
-- The trade is that this is a FLOOR, not the whole gate: RLS admits moderators
-- and above, and the route still checks the real permission, so an admin whose
-- view_space_ops was deliberately revoked is refused by the route. The cost is
-- that a role BELOW moderator granted view_space_ops would be blocked here and
-- see nothing. TestNoSubModeratorHoldsOpsView pins that: no seeded catalog entry
-- below moderator may hold view_space_ops, and the test fails loudly if one is
-- added.
CREATE OR REPLACE FUNCTION vc_space_ops_viewer(p_chat_id UUID) RETURNS BOOLEAN
SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM chat_members cm
     WHERE cm.chat_id = p_chat_id
       AND cm.user_id = vc_current_user_id()
       AND cm.left_at IS NULL
       AND cm.role IN ('moderator', 'admin', 'owner')
  );
$$ LANGUAGE sql STABLE;

-- ── row level security ──────────────────────────────────────────────
-- The privacy claim is enforced HERE, in the database, not in a handler.
--
-- A route-level filter is one forgotten WHERE clause away from leaking every
-- child in the school, and this change adds several routes that read the roster.
-- With the policy in place, a handler that forgets to scope returns fewer rows
-- than it expected — a bug that shows up as a missing row, not as a disclosure.
ALTER TABLE space_roster ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_roster FORCE  ROW LEVEL SECURITY;
ALTER TABLE space_links  ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_links  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS space_roster_select ON space_roster;
DROP POLICY IF EXISTS space_roster_write  ON space_roster;
DROP POLICY IF EXISTS space_links_select  ON space_links;
DROP POLICY IF EXISTS space_links_write   ON space_links;

-- You must be in the space AND either hold the space-wide view or be linked to
-- the entry. Your own entry is always visible: the walk starts there.
CREATE POLICY space_roster_select ON space_roster FOR SELECT USING (
  vc_is_chat_member(chat_id)
  AND (
    vc_space_ops_viewer(chat_id)
    OR space_can_view_roster(chat_id, vc_current_user_id(), id)
  )
);

-- Roster editing is an ops action. ALL rather than separate INSERT/UPDATE/DELETE
-- policies because the condition is identical for all three and three copies is
-- three chances to write one of them wrong. The route additionally requires
-- manage_roster — this is the floor.
CREATE POLICY space_roster_write ON space_roster FOR ALL
  USING (vc_is_chat_member(chat_id) AND vc_space_ops_viewer(chat_id))
  WITH CHECK (vc_is_chat_member(chat_id) AND vc_space_ops_viewer(chat_id));

-- A link is visible to ops, and to the person on the SUBJECT end — a parent may
-- see that they are linked to their child. Never from the object end: a child
-- must not be able to enumerate who watches them, and in a business space an
-- employee should not be able to read the reporting graph above them.
CREATE POLICY space_links_select ON space_links FOR SELECT USING (
  vc_is_chat_member(chat_id)
  AND (
    vc_space_ops_viewer(chat_id)
    OR EXISTS (
      SELECT 1 FROM space_roster r
       WHERE r.id = subject_id AND r.user_id = vc_current_user_id()
    )
  )
);

CREATE POLICY space_links_write ON space_links FOR ALL
  USING (vc_is_chat_member(chat_id) AND vc_space_ops_viewer(chat_id))
  WITH CHECK (vc_is_chat_member(chat_id) AND vc_space_ops_viewer(chat_id));
