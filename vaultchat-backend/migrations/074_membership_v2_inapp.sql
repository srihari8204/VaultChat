-- VaultChat: membership v2, part two — the in-app invitation has no token.
-- Idempotent.
--
-- 067 built the invitation around a signed token and a single-use invite_links
-- row: the invitation named a person, but what actually admitted them was a
-- DOOR they could be sent a key to. Membership v2 removes the door. An
-- invitation is now acted on by being signed in as the account it names, and
-- there is nothing to forward, paste, scan or screenshot.
--
-- That makes token_hash meaningless for new rows. It stays on the table because
-- invitations created before this migration still redeem through the old path,
-- and dropping the column would strand them.

-- ── the token becomes optional ──────────────────────────────────────
-- NOT NULL was right when every invitation had a token. Keeping it would force
-- the in-app path to invent a fake one purely to satisfy the constraint, and a
-- fake credential in a credentials column is how a future reader concludes the
-- tokens are real.
ALTER TABLE chat_invitations ALTER COLUMN token_hash DROP NOT NULL;

-- uq_chat_invitations_token stays as it is: Postgres treats NULLs as distinct
-- in a unique index, so any number of token-less invitations coexist while real
-- tokens remain unique. Made explicit here because relying on that silently is
-- exactly the sort of thing that gets "fixed" later by someone adding NULLS NOT
-- DISTINCT.

-- ── removal cooldown window, per group type ─────────────────────────
-- 069 recorded WHEN a removed member may return (group_removals.cooldown_until)
-- but not how that instant is chosen. Putting the window on the type config
-- keeps it tunable per kind of group without a release: a family group can
-- forgive in an hour, a work group might want a day.
--
-- 0 means no cooldown, which is the existing behaviour, so every type is
-- unchanged until someone deliberately sets one.
ALTER TABLE group_type_config
  ADD COLUMN IF NOT EXISTS removal_cooldown_hours INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'group_type_config'::regclass
       AND conname = 'group_type_config_cooldown_check'
  ) THEN
    ALTER TABLE group_type_config
      ADD CONSTRAINT group_type_config_cooldown_check
      CHECK (removal_cooldown_hours BETWEEN 0 AND 8760); -- at most a year
  END IF;
END $$;

-- ── the pending queue ───────────────────────────────────────────────
-- An owner's queue is "who is part-way in", which after 069 spans two statuses.
-- The 067 index is keyed on created_at for the sent-invitations list and does
-- not serve this.
CREATE INDEX IF NOT EXISTS idx_chat_invitations_live
  ON chat_invitations(chat_id, status)
  WHERE status IN ('pending', 'accepted');

-- ── join requests are invitations too ───────────────────────────────
-- A request is stored as a chat_invitations row with requested = TRUE and
-- inviter_id = invitee_user_id (you invited yourself). Recording that shape
-- here rather than only in the route means a reader of the schema can tell a
-- request from an invitation without reading Go.
COMMENT ON COLUMN chat_invitations.requested IS
  'TRUE when the invitee asked to join rather than being invited; such rows '
  'have inviter_id = invitee_user_id and start at status ''accepted'', because '
  'asking IS the consent step and only the owner''s approval remains.';
