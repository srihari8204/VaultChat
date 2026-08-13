-- VaultChat: Spaces & Operations — display roles, ops permissions, ops types.
-- Idempotent — safe to re-run.
--
-- Adds the FOURTH permission layer. Migration 070 established three:
--
--   1. type default   group_type_config.default_permissions   (per rank)
--   3. group override chats.permission_overrides              (per rank)
--   4. member grant   chat_members.permission_grants          (per member)
--
-- This inserts layer 2 between them:
--
--   2. role catalog   group_type_config.role_catalog          (per role_key)
--
-- WHY A CATALOG RATHER THAN NEW ROLES. A school has a Principal, a Transport
-- Manager, a Route Supervisor, a Driver, a Teacher and a Parent. A cab fleet has
-- a Fleet Manager and a Dispatcher. Modelling those as ROLES would mean widening
-- the chat_members.role CHECK, teaching internal/groups a new rank ordering, and
-- shipping a Go release every time a customer invents a job title. Worse, rank
-- comparison (CanRemoveMember, CanManageRole) is defined over a TOTAL ORDER, and
-- "is a Teacher above a Route Supervisor?" has no answer.
--
-- So: the five ranks stay exactly as they are and remain the only thing that
-- gates rank. A role_key is a LABEL plus a permission set, mapped onto one rank.
-- Adding "Route Supervisor" is a config row. Removing the owner is still
-- impossible for anyone, whatever their job title says.
--
-- Layer semantics are REPLACE, not merge — same as every other layer (see the
-- doc comment on internal/groups). A catalog entry that lists permissions gets
-- exactly those, not those plus its rank's defaults. That is what lets a Driver
-- (rank `member`) hold drive_run WITHOUT holding the member default
-- start_navigation: a driver navigating the group somewhere is not a thing.

-- ── layer 2: the role catalog ───────────────────────────────────────
-- Nullable. Every existing type gets NULL and resolves exactly as it does today.
ALTER TABLE group_type_config
  ADD COLUMN IF NOT EXISTS role_catalog JSONB;

-- A member's display role. Nullable, and NULL means "resolve from rank", which
-- is today's behaviour for every existing member. No backfill.
ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS role_key TEXT;

-- NOT validated by a CHECK constraint or a trigger. The valid permission names
-- live in internal/groups (Go) and lib/groups/permissions.ts (TypeScript), and a
-- third copy in PL/pgSQL is a third thing to drift. Validation is instead done
-- at PARSE time by groups.ParseRoleCatalog, which rejects the whole catalog on
-- any unknown rank or permission — so a hand-edited row fails CLOSED (the layer
-- vanishes and the rank default applies) rather than inventing a capability.

-- ── ops space types ─────────────────────────────────────────────────
-- Caps here are deliberately far above the social types': a school space is a
-- campus, not a chat. The cap trigger from 070 serialises one row lock per join,
-- which is fine at human join rates.
INSERT INTO group_type_config (group_type, label, default_icon, default_color, max_members, default_permissions) VALUES
  ('school_transport', 'School Transport', 'bus',       '#A855F7', 800,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements","create_tasks","manage_calendar","manage_album","manage_runs","view_space_ops","manage_roster","report_incident"],"moderator":["view_history","view_space_ops","send_announcements","report_incident"],"member":[],"guest":[]}'),
  ('office_transport', 'Office Transport', 'car',       '#14B8A6', 500,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements","create_tasks","manage_calendar","manage_album","manage_runs","view_space_ops","manage_roster","report_incident"],"moderator":["view_history","view_space_ops","send_announcements","report_incident"],"member":[],"guest":[]}'),
  ('pet_care',         'Pet Care',         'paw',       '#F59E0B', 20,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements","create_tasks","manage_calendar","manage_album","manage_roster"],"member":["view_history","start_navigation","create_tasks"],"guest":[]}')
ON CONFLICT (group_type) DO NOTHING;

-- ── ops permissions for the existing operational types ──────────────
-- school / business / office existed already but their admins hold none of the
-- new permissions, so without this an ops space would have no one able to create
-- a run. Rewritten wholesale rather than patched with jsonb_set: the full set is
-- readable in the diff, which a nested jsonb_set chain is not.
--
-- Caps are raised at the same time. A cap RAISE is always safe (the 070 trigger
-- only fires on insert and rejoin), and the previous 50 could not hold a school.
UPDATE group_type_config SET
  max_members = 800,
  default_permissions = '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements","create_tasks","manage_calendar","manage_album","manage_runs","view_space_ops","manage_roster","report_incident"],"moderator":["view_history","view_space_ops","send_announcements","report_incident"],"member":[],"guest":[]}'
WHERE group_type = 'school';

UPDATE group_type_config SET
  max_members = 500,
  default_permissions = '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements","create_tasks","manage_calendar","manage_album","manage_runs","view_space_ops","manage_roster","report_incident"],"moderator":["view_history","view_space_ops","send_announcements","report_incident"],"member":["start_navigation"],"guest":[]}'
WHERE group_type IN ('business', 'office');

-- ── role catalogs ───────────────────────────────────────────────────
-- Each entry: key (stable), label (display), rank (one of the five), and an
-- OPTIONAL permissions list that REPLACES the rank default for that key.
--
-- Note what the ranks buy us for free. Transport Manager is `admin`, Principal is
-- `owner`: a Transport Manager therefore cannot remove the Principal, because
-- CanRemoveMember compares ranks and nothing outranks an owner. That requirement
-- needed no new code.
--
-- Driver is `member` with an explicit list, so a driver holds drive_run and
-- report_incident and NOTHING else — not view_history, not the space dashboard.
-- Parent is `member` with an empty list: a parent's access comes entirely from
-- space_links (migration 085), never from a permission.
--
-- NOTE: no entry below `moderator` rank holds view_space_ops, and that is a
-- CONSTRAINT, not a coincidence. The RLS floor in 085 (vc_space_ops_viewer)
-- admits moderators and above, so a member-rank role granted view_space_ops
-- would be let through the route and then shown nothing by the database.
-- TestNoSubModeratorHoldsOpsView pins it. Teacher and Cab Owner therefore see
-- their class and their vehicles through `teaches` / `supervises` links — which
-- is the more correct answer anyway: a teacher has a class, not a campus.
UPDATE group_type_config SET role_catalog = '[
  {"key":"principal",         "label":"Principal",         "rank":"owner"},
  {"key":"school_admin",      "label":"School Admin",      "rank":"admin"},
  {"key":"transport_manager", "label":"Transport Manager", "rank":"admin",
   "permissions":["view_history","send_announcements","manage_runs","view_space_ops","manage_roster","report_incident","manage_zones"]},
  {"key":"route_supervisor",  "label":"Route Supervisor",  "rank":"moderator",
   "permissions":["view_history","view_space_ops","send_announcements","report_incident"]},
  {"key":"driver",            "label":"Bus Driver",        "rank":"member",
   "permissions":["drive_run","report_incident"]},
  {"key":"teacher",           "label":"Teacher",           "rank":"member",
   "permissions":["create_tasks","manage_calendar"]},
  {"key":"parent",            "label":"Parent",            "rank":"member",
   "permissions":[]},
  {"key":"student",           "label":"Student",           "rank":"guest",
   "permissions":[]}
]'::jsonb
WHERE group_type IN ('school', 'school_transport');

UPDATE group_type_config SET role_catalog = '[
  {"key":"company_owner",     "label":"Company Owner",     "rank":"owner"},
  {"key":"super_admin",       "label":"Super Admin",       "rank":"admin"},
  {"key":"hr_manager",        "label":"HR Manager",        "rank":"admin",
   "permissions":["view_history","send_announcements","view_space_ops","manage_roster","invite_members","remove_members"]},
  {"key":"dept_manager",      "label":"Department Manager","rank":"moderator",
   "permissions":["view_history","view_space_ops","send_announcements","manage_roster"]},
  {"key":"team_lead",         "label":"Team Lead",         "rank":"moderator",
   "permissions":["view_space_ops","send_announcements"]},
  {"key":"supervisor",        "label":"Supervisor",        "rank":"moderator",
   "permissions":["view_space_ops"]},
  {"key":"employee",          "label":"Employee",          "rank":"member",
   "permissions":[]},
  {"key":"visitor",           "label":"Visitor",           "rank":"guest",
   "permissions":[]}
]'::jsonb
WHERE group_type IN ('business', 'office');

UPDATE group_type_config SET role_catalog = '[
  {"key":"transport_admin",   "label":"Transport Admin",   "rank":"owner"},
  {"key":"fleet_manager",     "label":"Fleet Manager",     "rank":"admin",
   "permissions":["view_history","send_announcements","manage_runs","view_space_ops","manage_roster","report_incident","manage_zones"]},
  {"key":"dispatcher",        "label":"Dispatcher",        "rank":"moderator",
   "permissions":["view_space_ops","manage_runs","send_announcements"]},
  {"key":"cab_owner",         "label":"Cab Owner",         "rank":"member",
   "permissions":[]},
  {"key":"cab_driver",        "label":"Cab Driver",        "rank":"member",
   "permissions":["drive_run","report_incident"]},
  {"key":"rider",             "label":"Employee",          "rank":"member",
   "permissions":[]}
]'::jsonb
WHERE group_type = 'office_transport';

-- ── role_key sanity ─────────────────────────────────────────────────
-- An index, not a constraint: role_key's validity depends on the chat's type's
-- catalog, which is two joins away and mutable. Validity is enforced where the
-- key is ASSIGNED (the roster endpoints) and again at resolve time, where an
-- unrecognised key falls through to the rank default rather than granting
-- anything.
CREATE INDEX IF NOT EXISTS idx_chat_members_role_key
  ON chat_members(chat_id, role_key) WHERE role_key IS NOT NULL;
