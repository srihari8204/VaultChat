-- VaultChat: Groups & Circles — typed groups, roles, permissions, member caps.
-- Idempotent — safe to re-run.
--
-- Generalises Family Space (one hardcoded family circle) into many typed groups
-- per user. A group IS a chat: we deliberately do NOT introduce a parallel
-- `groups` table, because messages, members, invites, calls and search are all
-- already keyed on chat_id, and a second identity space would force a join on
-- every one of those paths. Group-ness is `type='group'` + a non-null group_type.
--
-- Permission model — resolved in three layers, cheapest first:
--   1. type default   group_type_config.default_permissions  (per role)
--   2. group override chats.permission_overrides             (per role, nullable)
--   3. member grant   chat_members.permission_grants         (per member, nullable)
-- Layers 2 and 3 are columns rather than tables ON PURPOSE: chatsLoadMem()
-- already joins chats to chat_members, so permission resolution costs zero
-- extra round trips on the hot path.
--
-- NOTE ON BACKFILL: existing Family Space circles CANNOT be stamped
-- group_type='family' here. The server has no marker for them — the client
-- tracks which groups are circles locally (AsyncStorage `vc_family_circles_v1`),
-- so only the client knows. Existing groups therefore keep group_type = NULL
-- ("untyped group") and behave exactly as before; the client stamps its own
-- circles via PATCH /chats/:id on first run after upgrade.

-- ── group metadata on chats ─────────────────────────────────────────
ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS group_type           TEXT,
  ADD COLUMN IF NOT EXISTS icon                 TEXT,
  ADD COLUMN IF NOT EXISTS color                TEXT,
  ADD COLUMN IF NOT EXISTS description          TEXT,
  ADD COLUMN IF NOT EXISTS privacy              TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS permission_overrides JSONB;

-- Constraints are added defensively so a re-run (or a partially applied
-- migration) doesn't abort the whole file.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'chats'::regclass AND conname = 'chats_privacy_check'
  ) THEN
    ALTER TABLE chats
      ADD CONSTRAINT chats_privacy_check
      CHECK (privacy IN ('private', 'invite_only'));
  END IF;
END $$;

-- group_type is intentionally NOT constrained to an enum: 'custom' groups and
-- future types must not require a migration. Validity is enforced by the
-- group_type_config lookup instead, which is data and therefore configurable.

-- ── guest role ──────────────────────────────────────────────────────
-- Widen the existing role CHECK. The constraint name is discovered rather than
-- assumed, because 002_chats.sql created it inline (Postgres-generated name).
DO $$
DECLARE cname TEXT;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'chat_members'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%role%'
   LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE chat_members DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE chat_members
    ADD CONSTRAINT chat_members_role_check
    CHECK (role IN ('guest', 'member', 'admin', 'owner'));
END $$;

ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS permission_grants JSONB;

-- ── per-type configuration (caps + defaults) ────────────────────────
-- Server-owned so raising a cap is a config change, never an app release.
-- The client reads max_members off the group payload and must not hardcode it.
CREATE TABLE IF NOT EXISTS group_type_config (
  group_type          TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  default_icon        TEXT NOT NULL,
  default_color       TEXT NOT NULL,
  min_members         INT  NOT NULL DEFAULT 2,
  max_members         INT  NOT NULL,
  default_permissions JSONB NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT group_type_config_members_sane CHECK (max_members >= min_members AND min_members >= 2)
);

-- Seeded, not hardcoded. A flat cap of 10 was rejected: it breaks the very
-- examples this change exists for (a cricket team needs 11 players; office and
-- college groups routinely exceed 10). Caps are per-type and tunable in place.
--
-- Permission keys: invite_members, remove_members, manage_zones, edit_settings,
-- view_history, start_navigation, send_announcements.
-- owner always holds every permission and is not listed per-type.
INSERT INTO group_type_config (group_type, label, default_icon, default_color, max_members, default_permissions) VALUES
  ('family',       'Family',       'home',        '#9D6FD0', 10,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["view_history","start_navigation"],"guest":[]}'),
  ('friends',      'Friends',      'people',      '#4A9FFF', 20,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["invite_members","start_navigation"],"guest":[]}'),
  ('office',       'Office',       'briefcase',   '#14B8A6', 50,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["start_navigation"],"guest":[]}'),
  ('colleagues',   'Colleagues',   'people-circle','#0EA5E9', 50,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["start_navigation"],"guest":[]}'),
  ('travel',       'Travel',       'airplane',    '#F59E0B', 15,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["view_history","start_navigation"],"guest":[]}'),
  ('school',       'School',       'school',      '#A855F7', 50,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["view_history"],"guest":[]}'),
  ('college',      'College',      'library',     '#8B5CF6', 50,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["invite_members","start_navigation"],"guest":[]}'),
  ('sports',       'Sports',       'football',    '#22C55E', 30,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["start_navigation"],"guest":[]}'),
  ('emergency',    'Emergency',    'medkit',      '#EF4444', 10,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["view_history","start_navigation","send_announcements"],"guest":[]}'),
  ('neighborhood', 'Neighborhood', 'business',    '#F97316', 50,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["start_navigation"],"guest":[]}'),
  ('business',     'Business',     'storefront',  '#EC4899', 50,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["start_navigation"],"guest":[]}'),
  ('custom',       'Custom',       'ellipse',     '#6B7280', 20,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements"],"member":["start_navigation"],"guest":[]}')
ON CONFLICT (group_type) DO NOTHING;

-- ── audit log ───────────────────────────────────────────────────────
-- Member/role/settings changes are recorded so a group can answer "who removed
-- them, and when". Detail is PII-free metadata only — never message content.
CREATE TABLE IF NOT EXISTS group_audit_log (
  id         BIGSERIAL PRIMARY KEY,
  chat_id    UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_audit_chat
  ON group_audit_log(chat_id, created_at DESC);

-- ── member cap enforcement ──────────────────────────────────────────
-- Enforced in the DATABASE, not just the route, because the cap is a race:
-- concurrent joins each pass an application-level "is there room?" check and
-- then all insert.
--
-- A trigger ALONE is not enough, and this was verified rather than assumed: with
-- a plain COUNT(*), two concurrent transactions under READ COMMITTED each see
-- 2 of 3 seats used (neither sees the other's uncommitted row) and both commit,
-- producing 4 members in a cap-3 group. The fix is to serialise writers on the
-- GROUP: take a row lock on the chats row first, so concurrent joins to the same
-- group queue behind each other and the second one counts the first.
--
-- FOR NO KEY UPDATE (not FOR UPDATE) is deliberate: it serialises against other
-- cap checks while still permitting the ordinary foreign-key references to this
-- chat row that the rest of the schema takes constantly.
--
-- Counts only ACTIVE members (left_at IS NULL), so a member who left frees a
-- seat. Untyped groups (group_type IS NULL) are unlimited, preserving the
-- current behaviour of every group created before this migration.
CREATE OR REPLACE FUNCTION group_enforce_member_cap() RETURNS TRIGGER AS $$
DECLARE
  cap      INT;
  gtype    TEXT;
  active   INT;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;              -- leaving never needs a seat
  END IF;

  -- Serialisation point. Everything below counts a stable seat total.
  SELECT c.group_type INTO gtype
    FROM chats c
   WHERE c.id = NEW.chat_id
     FOR NO KEY UPDATE;

  IF gtype IS NULL THEN
    RETURN NEW;              -- untyped legacy group: uncapped
  END IF;

  SELECT g.max_members INTO cap FROM group_type_config g WHERE g.group_type = gtype;
  IF cap IS NULL THEN
    RETURN NEW;              -- unknown type: fail open rather than lock users out
  END IF;

  SELECT COUNT(*) INTO active
    FROM chat_members
   WHERE chat_id = NEW.chat_id
     AND left_at IS NULL
     AND user_id <> NEW.user_id;

  IF active + 1 > cap THEN
    RAISE EXCEPTION 'group_member_cap_exceeded: % of % seats used', active, cap
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A cap REDUCTION must never evict anyone: the trigger only fires on insert and
-- on a rejoin (left_at NULL-ing), so existing members are untouched and an
-- over-capacity group simply stops accepting new joins.
DROP TRIGGER IF EXISTS chat_members_cap ON chat_members;
CREATE CONSTRAINT TRIGGER chat_members_cap
  AFTER INSERT OR UPDATE OF left_at ON chat_members
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION group_enforce_member_cap();

CREATE INDEX IF NOT EXISTS idx_chats_group_type
  ON chats(group_type) WHERE group_type IS NOT NULL;
