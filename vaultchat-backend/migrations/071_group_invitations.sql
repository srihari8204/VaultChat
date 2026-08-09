-- VaultChat: per-invitee group invitations (Groups & Circles, G1).
-- Idempotent — safe to re-run.
--
-- WHY THIS EXISTS, given 025_invite_links.sql already works:
--   invite_links models a DOOR — a shareable code anyone may walk through.
--   chat_invitations models a PERSON — "Priya was invited on Tuesday, has not
--   answered". The link table has nowhere to put an invitee, so questions like
--   "who have we invited?" and "resend to Priya" are unanswerable today.
--
-- The two compose rather than compete. A per-invitee invitation MINTS a
-- single-use invite_links row and points at it, so redemption keeps using the
-- existing concurrency-safe vc_redeem_invite() path — which already holds a row
-- lock, honours expiry and max_uses, and un-leaves a returning member. We add
-- status tracking around it; we do not reimplement joining.
--
-- Bare links keep working untouched for "share to WhatsApp" flows where there
-- is no addressable invitee yet.

CREATE TABLE IF NOT EXISTS chat_invitations (
  id              BIGSERIAL PRIMARY KEY,
  chat_id         UUID        NOT NULL REFERENCES chats(id)  ON DELETE CASCADE,
  inviter_id      UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,

  -- Who was invited. invitee_user_id is set when we could resolve the person to
  -- an account; invitee_ref holds the addressed handle otherwise.
  --
  -- PRIVACY: a phone number is stored ONLY as its lookup hash (vault.PhoneLookup),
  -- never in the clear, matching how contact discovery already handles phones.
  -- An email is stored lowercased because the users table already holds it.
  invitee_user_id UUID        REFERENCES users(id) ON DELETE CASCADE,
  invitee_kind    TEXT        NOT NULL,
  invitee_ref     TEXT,

  -- How it was delivered, for the sent-invitations list. Not security-relevant.
  channel         TEXT        NOT NULL DEFAULT 'link',

  -- The single-use door this invitation opens. NULL once revoked/expired and
  -- the link has been cleaned up.
  link_id         BIGINT      REFERENCES invite_links(id) ON DELETE SET NULL,

  -- Only the HMAC of the token is stored. A database leak therefore does not
  -- yield working invitations.
  token_hash      TEXT        NOT NULL,

  status          TEXT        NOT NULL DEFAULT 'pending',
  expires_at      TIMESTAMPTZ NOT NULL,
  responded_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chat_invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'revoked')),
  CONSTRAINT chat_invitations_kind_check
    CHECK (invitee_kind IN ('user', 'phone', 'email', 'link')),
  -- A resolved invitee must carry an account; an unresolved one must carry a
  -- handle. Without this a row can identify nobody at all.
  CONSTRAINT chat_invitations_identifies_someone
    CHECK (invitee_user_id IS NOT NULL OR invitee_ref IS NOT NULL OR invitee_kind = 'link'),
  -- Terminal states must record when they happened.
  CONSTRAINT chat_invitations_responded_when_terminal
    CHECK (status = 'pending' OR responded_at IS NOT NULL)
);

-- DUPLICATE GUARD, enforced in the database rather than the route: two admins
-- inviting the same person at the same moment would both pass an application
-- level "is there a pending invite?" check. A partial unique index cannot be
-- raced.
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_invitations_pending_user
  ON chat_invitations(chat_id, invitee_user_id)
  WHERE status = 'pending' AND invitee_user_id IS NOT NULL;

-- Same guard for invitees we could not resolve to an account (phone/email).
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_invitations_pending_ref
  ON chat_invitations(chat_id, invitee_kind, invitee_ref)
  WHERE status = 'pending' AND invitee_user_id IS NULL AND invitee_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_invitations_chat
  ON chat_invitations(chat_id, created_at DESC);

-- The invitee's own "invitations waiting for me" list.
CREATE INDEX IF NOT EXISTS idx_chat_invitations_invitee
  ON chat_invitations(invitee_user_id, status)
  WHERE invitee_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_invitations_token
  ON chat_invitations(token_hash);

-- ── effective status ────────────────────────────────────────────────
-- A row sitting at 'pending' past its expiry IS expired; it just has not been
-- written to. Deriving that at read time is cheaper and more correct than a
-- sweeper job, which would leave a window where the stored value lies.
CREATE OR REPLACE FUNCTION vc_invitation_status(p_status TEXT, p_expires TIMESTAMPTZ)
RETURNS TEXT AS $$
BEGIN
  IF p_status = 'pending' AND p_expires < NOW() THEN
    RETURN 'expired';
  END IF;
  RETURN p_status;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── redeem: FIX A LIVE BUG, then extend ─────────────────────────────
--
-- BUG (pre-existing, since migration 025): vc_redeem_invite has ALWAYS failed.
-- Its RETURNS TABLE declares OUT parameters named `chat_id` and `status`, and
-- the body's `ON CONFLICT (chat_id, user_id)` then cannot be resolved:
--
--   ERROR: column reference "chat_id" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- routes/chats.go chatsJoinByCode() calls this function on the live join path
-- and maps any error to 500 "Failed to join via link". Net effect: joining a
-- group by invite link has never worked — every attempt 500s. The Node route
-- (vaultchat-backend/routes/chats.js) calls it identically and fails the same
-- way, which is why this survived the Go migration unnoticed.
--
-- FIX: `#variable_conflict use_column` tells PL/pgSQL to resolve an ambiguous
-- identifier to the COLUMN. That is the correct reading everywhere in this body
-- — every genuine reference to the OUT parameters is either qualified (l.chat_id)
-- or in a RETURN QUERY target list, neither of which is affected.
--
-- EXTENSION: the INSERT can now also raise group_member_cap_exceeded from
-- migration 070's trigger. Unhandled that is another 500 for the ordinary
-- outcome "the group is full", so it is caught and reported as a status
-- alongside the existing 'ok' | 'invalid' | 'expired' | 'used'.
CREATE OR REPLACE FUNCTION vc_redeem_invite(p_code TEXT, p_user UUID)
RETURNS TABLE(chat_id UUID, status TEXT) AS $$
#variable_conflict use_column
DECLARE
  l invite_links%ROWTYPE;
BEGIN
  SELECT * INTO l FROM invite_links WHERE code = p_code FOR UPDATE;
  IF NOT FOUND OR l.revoked THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid'; RETURN;
  END IF;
  IF l.expires_at IS NOT NULL AND l.expires_at < NOW() THEN
    RETURN QUERY SELECT NULL::uuid, 'expired'; RETURN;
  END IF;
  IF l.max_uses > 0 AND l.uses >= l.max_uses THEN
    RETURN QUERY SELECT NULL::uuid, 'used'; RETURN;
  END IF;

  BEGIN
    INSERT INTO chat_members (chat_id, user_id, role)
    VALUES (l.chat_id, p_user, 'member')
    ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL;
  EXCEPTION WHEN check_violation THEN
    -- The member-cap trigger from migration 070. Not an error condition.
    RETURN QUERY SELECT NULL::uuid, 'full'; RETURN;
  END;

  UPDATE invite_links SET uses = uses + 1 WHERE id = l.id;

  -- Settle the invitation this link belongs to, if any. A bare link has none.
  UPDATE chat_invitations
     SET status = 'accepted', responded_at = NOW()
   WHERE link_id = l.id AND status = 'pending';

  RETURN QUERY SELECT l.chat_id, 'ok';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
