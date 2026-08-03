-- VaultChat Day-1 hardening: Row-Level Security on user-data tables.
-- Idempotent — safe to re-run.
--
-- Model:
--   The backend connects as `vaultchat_app` (no BYPASSRLS by default in
--   Postgres for non-superusers — verify with: \du vaultchat_app).
--
--   NOTE: \du checks the BYPASSRLS *attribute*, which is necessary but NOT
--   sufficient. Postgres also exempts a table's OWNER from that table's own
--   policies unless the table is set to FORCE ROW LEVEL SECURITY, and no
--   migration here does that. If vaultchat_app owns these tables, every policy
--   below is inert and \du will not say so. Check with:
--       psql "$DATABASE_URL" -f scripts/check-rls.sql
--   and see docs/RLS_ENFORCEMENT.md. Do not flip FORCE on casually: `chats`
--   has no INSERT policy at all, so enforcing it denies every chat creation
--   until one is written.
--
--   Before every user-bound query the backend issues:
--       SET LOCAL app.current_user_id = '<uuid>';
--   inside a transaction. RLS policies read that setting via
--   vc_current_user_id() and gate row visibility.
--
--   System-internal queries (e.g. Socket.IO fan-out, which doesn't
--   belong to any specific user) use SECURITY DEFINER helper functions
--   that explicitly bypass RLS — see vc_chat_member_ids() below.
--
--   Tables WITHOUT RLS (intentional):
--     users          — read by auth routes (find by email) and chat
--                      member display. Sensitive columns (pin_hash,
--                      security_a*_hash, google_sub) are protected by
--                      column-level GRANTs at a later phase.
--     otp_codes      — auth-route-only access, short-lived
--     refresh_tokens — auth-route-only access, hashed contents

-- ── Helper: read the current request's user id ──────────────
-- Returns NULL if the connection didn't SET app.current_user_id —
-- which causes every RLS policy below to reject access. That's the
-- safe default for any code path that forgets to bind a user.
CREATE OR REPLACE FUNCTION vc_current_user_id() RETURNS UUID AS $$
DECLARE
  raw TEXT;
BEGIN
  raw := current_setting('app.current_user_id', true);
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER;

-- ── Helper: is the current user a member of this chat? ─────
CREATE OR REPLACE FUNCTION vc_is_chat_member(p_chat_id UUID) RETURNS BOOLEAN AS $$
DECLARE
  uid UUID := vc_current_user_id();
BEGIN
  IF uid IS NULL THEN RETURN FALSE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM chat_members
    WHERE chat_id = p_chat_id AND user_id = uid AND left_at IS NULL
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ── Helper: is the current user an admin/owner of this chat? ──
CREATE OR REPLACE FUNCTION vc_is_chat_admin(p_chat_id UUID) RETURNS BOOLEAN AS $$
DECLARE
  uid UUID := vc_current_user_id();
BEGIN
  IF uid IS NULL THEN RETURN FALSE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM chat_members
    WHERE chat_id = p_chat_id AND user_id = uid AND left_at IS NULL
      AND role IN ('admin', 'owner')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ── System helper: get member ids for fan-out (bypasses RLS) ──
-- Server-side Socket.IO fan-out doesn't run on behalf of a user;
-- the message-write transaction already validated membership.
-- Marked SECURITY DEFINER so it executes with the function-owner's
-- privileges, effectively bypassing RLS for system use cases.
CREATE OR REPLACE FUNCTION vc_chat_member_ids(p_chat_id UUID) RETURNS SETOF UUID AS $$
  SELECT user_id FROM chat_members WHERE chat_id = p_chat_id AND left_at IS NULL;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- ── chats ───────────────────────────────────────────────────
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chats_select  ON chats;
DROP POLICY IF EXISTS chats_update  ON chats;
DROP POLICY IF EXISTS chats_delete  ON chats;

CREATE POLICY chats_select ON chats FOR SELECT USING (vc_is_chat_member(id));
CREATE POLICY chats_update ON chats FOR UPDATE USING (vc_is_chat_admin(id));
CREATE POLICY chats_delete ON chats FOR DELETE USING (vc_is_chat_admin(id));
-- INSERT is intentionally unrestricted at the row level: chat creation
-- happens in routes/chats.js which inserts the chat row + creator's
-- membership in a single transaction. Without a corresponding member
-- row, no SELECT/UPDATE/DELETE can ever succeed.

-- ── chat_members ────────────────────────────────────────────
ALTER TABLE chat_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_members_select  ON chat_members;
DROP POLICY IF EXISTS chat_members_insert  ON chat_members;
DROP POLICY IF EXISTS chat_members_update  ON chat_members;
DROP POLICY IF EXISTS chat_members_delete  ON chat_members;

-- See members of chats you're in
CREATE POLICY chat_members_select ON chat_members FOR SELECT USING (vc_is_chat_member(chat_id));
-- Add members:
--   * Bootstrap: first member of a brand-new chat must be the current user
--     (otherwise nobody can ever create a chat — there'd be no admin yet)
--   * Otherwise must be an admin/owner of the chat
CREATE POLICY chat_members_insert ON chat_members FOR INSERT WITH CHECK (
  (user_id = vc_current_user_id() AND NOT EXISTS (
    SELECT 1 FROM chat_members cm2 WHERE cm2.chat_id = chat_id
  ))
  OR vc_is_chat_admin(chat_id)
);
-- Edit your own row (mark read, mute); admins can edit any row
CREATE POLICY chat_members_update ON chat_members FOR UPDATE USING (
  user_id = vc_current_user_id() OR vc_is_chat_admin(chat_id)
);
-- Remove yourself (leave) or admin removes someone
CREATE POLICY chat_members_delete ON chat_members FOR DELETE USING (
  user_id = vc_current_user_id() OR vc_is_chat_admin(chat_id)
);

-- ── messages ───────────────────────────────────────────────
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_select  ON messages;
DROP POLICY IF EXISTS messages_insert  ON messages;
DROP POLICY IF EXISTS messages_update  ON messages;
DROP POLICY IF EXISTS messages_delete  ON messages;

CREATE POLICY messages_select ON messages FOR SELECT USING (vc_is_chat_member(chat_id));
CREATE POLICY messages_insert ON messages FOR INSERT WITH CHECK (
  sender_id = vc_current_user_id() AND vc_is_chat_member(chat_id)
);
CREATE POLICY messages_update ON messages FOR UPDATE USING (
  sender_id = vc_current_user_id() AND vc_is_chat_member(chat_id)
);
CREATE POLICY messages_delete ON messages FOR DELETE USING (
  sender_id = vc_current_user_id() AND vc_is_chat_member(chat_id)
);

-- ── attachments ────────────────────────────────────────────
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attachments_select  ON attachments;
DROP POLICY IF EXISTS attachments_insert  ON attachments;
DROP POLICY IF EXISTS attachments_update  ON attachments;
DROP POLICY IF EXISTS attachments_delete  ON attachments;

-- Owner sees their own. Other users see attachments referenced by any
-- message in a chat they're a member of. (Subquery uses messages.meta
-- JSONB so no extra index needed at MVP scale.)
CREATE POLICY attachments_select ON attachments FOR SELECT USING (
  owner_user_id = vc_current_user_id()
  OR EXISTS (
    SELECT 1 FROM messages m
    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = vc_current_user_id() AND cm.left_at IS NULL
    WHERE m.meta->>'attachmentId' = attachments.id::text
  )
);
CREATE POLICY attachments_insert ON attachments FOR INSERT WITH CHECK (owner_user_id = vc_current_user_id());
CREATE POLICY attachments_update ON attachments FOR UPDATE USING (owner_user_id = vc_current_user_id());
CREATE POLICY attachments_delete ON attachments FOR DELETE USING (owner_user_id = vc_current_user_id());

-- ── Verify the policy attaches as expected (informational) ──
DO $$
BEGIN
  RAISE NOTICE 'RLS enabled on: chats, chat_members, messages, attachments';
  RAISE NOTICE 'Backend must SET LOCAL app.current_user_id before user-bound queries';
END $$;
