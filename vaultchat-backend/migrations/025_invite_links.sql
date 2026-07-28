-- Group invite links (invite-link screen). Idempotent.
--
-- A shareable code that lets anyone join a group chat. Admins create/revoke;
-- joining increments `uses` and inserts a chat_members row. Because
-- chat_members has RLS that only lets admins (or the bootstrap creator) add
-- members, self-join via a link must go through the SECURITY DEFINER
-- vc_redeem_invite() helper below, which runs with the table-owner's rights
-- and so bypasses RLS — the same pattern used by vc_chat_member_ids().

CREATE TABLE IF NOT EXISTS invite_links (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT        NOT NULL UNIQUE,
  chat_id     UUID        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  created_by  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,                 -- NULL = never expires
  max_uses    INT         NOT NULL DEFAULT 0,   -- 0 = unlimited
  uses        INT         NOT NULL DEFAULT 0,
  revoked     BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_invite_links_chat ON invite_links(chat_id, created_at DESC);

-- Redeem a code on behalf of p_user. Returns (chat_id, status) where status
-- is one of: 'ok' | 'invalid' | 'expired' | 'used'. Validates, inserts the
-- membership (idempotent, un-leaving a prior member), and bumps the counter,
-- all under a row lock so concurrent redemptions can't overshoot max_uses.
CREATE OR REPLACE FUNCTION vc_redeem_invite(p_code TEXT, p_user UUID)
RETURNS TABLE(chat_id UUID, status TEXT) AS $$
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

  INSERT INTO chat_members (chat_id, user_id, role)
  VALUES (l.chat_id, p_user, 'member')
  ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL;

  UPDATE invite_links SET uses = uses + 1 WHERE id = l.id;

  RETURN QUERY SELECT l.chat_id, 'ok';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
