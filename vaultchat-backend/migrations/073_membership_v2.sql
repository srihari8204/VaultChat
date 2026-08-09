-- VaultChat: in-app membership v2 (Groups & Circles). Idempotent.
--
-- Revises the invitation model from migration 071 for a fully in-app flow.
-- Nothing external: no links to share, no QR, no SMS. An invitation now names a
-- VaultChat user and travels as a notification inside the app.
--
-- THE CENTRAL CHANGE IS A THIRD STEP.
-- 067 modelled invite -> redeem -> joined. The flow this replaces it with is:
--
--   Strict (default)   owner invites -> user ACCEPTS -> owner APPROVES -> joined
--   User approval      owner invites -> user accepts -> joined
--   Admin approval     user REQUESTS -> owner approves -> joined
--
-- So "accepted" and "joined" stop being the same thing. A user who accepted is
-- consenting; a user who joined is a member. Collapsing them, as 067 did, makes
-- strict mode impossible to express — there would be nowhere to sit between the
-- invitee saying yes and the owner saying yes.

-- ── approval mode, per group ────────────────────────────────────────
ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS approval_mode TEXT NOT NULL DEFAULT 'strict';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'chats'::regclass AND conname = 'chats_approval_mode_check'
  ) THEN
    ALTER TABLE chats
      ADD CONSTRAINT chats_approval_mode_check
      CHECK (approval_mode IN ('strict', 'user_approval', 'admin_approval'));
  END IF;
END $$;

-- ── moderator role ──────────────────────────────────────────────────
-- Sits between admin and member: can moderate content and manage members, but
-- cannot edit the group itself or change roles.
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
    CHECK (role IN ('guest', 'member', 'moderator', 'admin', 'owner'));
END $$;

-- ── invitation lifecycle ────────────────────────────────────────────
-- 'accepted' now means "the invitee consented, awaiting owner approval".
-- 'joined'   means "membership granted".
-- 'cancelled' is the inviter withdrawing, distinct from 'rejected' (the invitee
-- declining) — conflating them would lose who ended it, which is exactly what
-- an audit trail exists to answer.
-- Dropped BY NAME, not by pattern. An earlier draft discovered the constraint
-- with ILIKE '%status%', which also matches chat_invitations_responded_when_terminal
-- ("CHECK (status = 'pending' OR responded_at IS NOT NULL)") — so a re-run could
-- drop the wrong constraint and then fail adding one that already existed.
ALTER TABLE chat_invitations DROP CONSTRAINT IF EXISTS chat_invitations_status_check;
ALTER TABLE chat_invitations
  ADD CONSTRAINT chat_invitations_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'revoked', 'cancelled', 'joined'));

-- 067 required responded_at for anything that was not 'pending'. That no longer
-- holds: 'accepted' is now an INTERMEDIATE state (the invitee consented, the
-- owner has not yet approved), and it is stamped with accepted_at instead.
-- Leaving the old rule would make it impossible to record an acceptance.
ALTER TABLE chat_invitations DROP CONSTRAINT IF EXISTS chat_invitations_responded_when_terminal;

ALTER TABLE chat_invitations
  -- When the invitee consented, separate from when membership was granted.
  ADD COLUMN IF NOT EXISTS accepted_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS joined_at    TIMESTAMPTZ,
  -- Set when a member requested to join rather than being invited.
  ADD COLUMN IF NOT EXISTS requested    BOOLEAN NOT NULL DEFAULT FALSE;

-- Re-stated for the new lifecycle: an acceptance records accepted_at, and only
-- a genuinely finished invitation records responded_at.
ALTER TABLE chat_invitations DROP CONSTRAINT IF EXISTS chat_invitations_timestamps;
ALTER TABLE chat_invitations
  ADD CONSTRAINT chat_invitations_timestamps CHECK (
    (status = 'pending')
    OR (status = 'accepted' AND accepted_at IS NOT NULL)
    OR (status IN ('rejected','expired','revoked','cancelled') AND responded_at IS NOT NULL)
    OR (status = 'joined' AND joined_at IS NOT NULL)
  );

-- The pending-duplicate guard from 067 must now also cover 'accepted': someone
-- awaiting approval already has a live invitation, and inviting them again
-- would create a second one the owner has to reason about.
DROP INDEX IF EXISTS uq_chat_invitations_pending_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_invitations_live_user
  ON chat_invitations(chat_id, invitee_user_id)
  WHERE status IN ('pending', 'accepted') AND invitee_user_id IS NOT NULL;

-- ── removed-member cooldown ─────────────────────────────────────────
-- A member who was removed should not be re-invitable straight away, or a
-- removal becomes a formality anyone can undo in one tap. The window is data,
-- not a constant, so it can be tuned without a release.
CREATE TABLE IF NOT EXISTS group_removals (
  chat_id    UUID        NOT NULL REFERENCES chats(id)  ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  removed_by UUID        REFERENCES users(id) ON DELETE SET NULL,
  removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = no cooldown, they may be re-invited immediately.
  cooldown_until TIMESTAMPTZ,
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_removals_cooldown
  ON group_removals(chat_id, cooldown_until)
  WHERE cooldown_until IS NOT NULL;

-- ── per-group feature access ────────────────────────────────────────
-- Which shared surfaces a group exposes at all. Absent means everything is on,
-- so existing groups are unaffected.
ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS feature_access JSONB;

-- ── new group types ─────────────────────────────────────────────────
-- Added, never replacing: removing a type would orphan every group already
-- using it.
INSERT INTO group_type_config (group_type, label, default_icon, default_color, max_members, default_permissions) VALUES
  ('pet_care', 'Pet Care', 'paw', '#F59E0B', 10,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements","create_tasks","manage_calendar","manage_album"],"moderator":["invite_members","remove_members","create_tasks","manage_album"],"member":["view_history","create_tasks"],"guest":[]}'),
  ('riders', 'Riders', 'bicycle', '#EF4444', 10,
   '{"admin":["invite_members","remove_members","manage_zones","edit_settings","view_history","start_navigation","send_announcements","create_tasks","manage_calendar","manage_album"],"moderator":["invite_members","remove_members","create_tasks","manage_album"],"member":["start_navigation","create_tasks"],"guest":[]}')
ON CONFLICT (group_type) DO NOTHING;

-- Give every existing type a moderator preset and the three new permissions.
-- Done as a merge rather than an overwrite so any hand-tuned group keeps its
-- configuration.
UPDATE group_type_config
   SET default_permissions = default_permissions
     || '{"moderator":["invite_members","remove_members","create_tasks","manage_album"]}'::jsonb
 WHERE NOT (default_permissions ? 'moderator');

-- Admins gain the three new permissions wherever they already hold edit_settings.
UPDATE group_type_config
   SET default_permissions = jsonb_set(
         default_permissions, '{admin}',
         (SELECT jsonb_agg(DISTINCT p) FROM (
            SELECT jsonb_array_elements_text(default_permissions->'admin') AS p
            UNION SELECT unnest(ARRAY['create_tasks','manage_calendar','manage_album'])
          ) q))
 WHERE default_permissions->'admin' ? 'edit_settings';
