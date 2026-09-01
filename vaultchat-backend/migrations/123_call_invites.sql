-- 123_call_invites.sql
-- Let someone already on a call vouch for a person who is not in the chat, so a
-- 1:1 call can gain a third participant without anybody being added to the chat.
-- Idempotent. One table, its policies, and one index.
--
-- WHY THIS EXISTS
--
--   A call room is keyed by calls.id. To receive an SFU token you must be a LIVE
--   participant; to become one you POST /calls, which may only admit a member of
--   that chat. For a 1:1 chat a third person is not a member, so there was no
--   way to add them to a call at all — the "add person to a call" that every
--   other messenger has could not be built on top of the existing rules.
--
--   This is the grant that makes it possible, and it is deliberately the
--   NARROWEST one that works:
--
--     * scoped to ONE call, not to the chat. Being invited to a call gives no
--       access to the conversation, its history, or any future call.
--     * only a LIVE participant may issue it (enforced in the handler), so an
--       outsider cannot invite themselves or anyone else.
--     * it dies with the call. Rows are kept for the audit trail but mean
--       nothing once calls.ended_at is set, because the join re-checks the call
--       is live before it consults this table.
--
-- A NOTE ON RLS, WHICH IS WHY THE HANDLER CHECKS TOO
--
--   Policies are defined below for correctness and for any client that connects
--   as a non-privileged role. They are NOT the enforcement in this deployment:
--   the API connects as `vaultchat`, which is superuser + BYPASSRLS, and such a
--   role ignores row-level security entirely — FORCE ROW LEVEL SECURITY
--   included. Verified against production. The real check lives in
--   routes/call_sessions.go (mayJoinCall). Do not delete it believing these
--   policies cover it.

CREATE TABLE IF NOT EXISTS call_invites (
  call_id     UUID        NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  invitee_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (call_id, invitee_id)
);

-- The join asks "is this person invited to THIS call", which the primary key
-- already answers. This index serves the other direction — "what am I invited
-- to" — used when a device comes back online and reconciles.
CREATE INDEX IF NOT EXISTS call_invites_invitee_idx
  ON call_invites (invitee_id, created_at DESC);

ALTER TABLE call_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_invites FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_invites_select ON call_invites;
DROP POLICY IF EXISTS call_invites_insert ON call_invites;

-- You may see an invite that is yours, or one you issued.
CREATE POLICY call_invites_select ON call_invites FOR SELECT
  USING (invitee_id = vc_current_user_id() OR invited_by = vc_current_user_id());

-- You may only issue an invite AS YOURSELF, and only to a call you are on.
CREATE POLICY call_invites_insert ON call_invites FOR INSERT
  WITH CHECK (
    invited_by = vc_current_user_id()
    AND EXISTS (
      SELECT 1 FROM call_participants p
       WHERE p.call_id = call_invites.call_id
         AND p.user_id = vc_current_user_id()
         AND p.left_at IS NULL)
  );
