-- 067_rls_chats_insert.sql
-- The missing `chats` INSERT policy. Idempotent.
--
-- 004_rls.sql enables RLS on `chats` and writes SELECT, UPDATE and DELETE
-- policies, then says:
--
--   "INSERT is intentionally unrestricted at the row level"
--
-- That is the opposite of what Postgres does. With RLS enabled, a command with
-- NO policy is DENIED, not permitted. So chat creation is not "unrestricted" —
-- under enforced RLS it is impossible.
--
-- It works in practice only because RLS is currently bypassed: no table here is
-- FORCE'd, and a table's owner is exempt from its own policies. See
-- docs/RLS_ENFORCEMENT.md. This migration closes the gap so that the day
-- enforcement is switched on, chat creation does not become the first casualty.
--
-- APPLYING THIS CHANGES NOTHING TODAY. Adding a permissive policy to a table
-- whose policies are already bypassed is a no-op for every current code path;
-- it only matters once FORCE is set.
--
-- WHAT THE POLICY CAN CHECK
-- -------------------------
-- Not much, and that is correct rather than a compromise. routes/chats.go
-- inserts the chat row and the creator's membership in ONE transaction, so at
-- the moment the chat row is written there is no member row to test against —
-- any policy referring to chat_members would reject the very first statement of
-- every chat that has ever been created.
--
-- So the rule is the true one: an authenticated user may create a chat. That is
-- also the real product rule — anyone may start a conversation. The protection
-- that matters lives one statement later, on chat_members, whose INSERT policy
-- allows the bootstrap row ONLY when it is the current user's own membership in
-- a chat that has no members yet. A chat with no member row is unreachable:
-- chats_select, chats_update and chats_delete all require membership, so an
-- attacker who inserted a bare chat row would have created something they
-- cannot read, join, modify or find.

DROP POLICY IF EXISTS chats_insert ON chats;

CREATE POLICY chats_insert ON chats FOR INSERT WITH CHECK (
  vc_current_user_id() IS NOT NULL
);
