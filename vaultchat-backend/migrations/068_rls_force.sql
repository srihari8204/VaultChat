-- 068_rls_force.sql
-- Make the RLS policies actually apply. Idempotent.
--
-- ⚠️  DO NOT APPLY THIS UNTIL THE SYSTEM ROLE EXISTS. See the checklist below
--     and docs/RLS_ENFORCEMENT.md. Applying it early does not corrupt anything,
--     but it WILL make background sweeps and fan-out silently read zero rows.
--
-- WHAT IT DOES
-- ------------
-- ENABLE ROW LEVEL SECURITY (004_rls.sql) does nothing to a table's OWNER.
-- Postgres exempts the owner unless the table is also FORCE'd. If the role the
-- app connects as owns these tables — the normal outcome when migrations are
-- applied as that role — every policy written in 004_rls.sql is inert. A policy
-- of `USING (false)` still returns rows to the owner; that is demonstrated, not
-- assumed.
--
-- This is the one statement per table that closes it.
--
-- PRE-FLIGHT CHECKLIST
-- --------------------
--  1. Confirm you actually need this:
--         psql "$DATABASE_URL" -f scripts/check-rls.sql
--     If the verdict column already says "enforced" or "ENFORCED" for these
--     tables, the app role does not own them and there is nothing to fix.
--
--  2. Migration 067 must be applied. `chats` has no INSERT policy before it,
--     and with RLS in force "no policy" means DENY — chat creation would be the
--     first thing to break.
--
--  3. A system role must exist and the API must be pointed at it:
--
--         CREATE ROLE vaultchat_system LOGIN PASSWORD '…' BYPASSRLS;
--         GRANT ALL ON ALL TABLES IN SCHEMA public TO vaultchat_system;
--         GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO vaultchat_system;
--         ALTER DEFAULT PRIVILEGES IN SCHEMA public
--           GRANT ALL ON TABLES TO vaultchat_system;
--
--     then DB_SYSTEM_USER / DB_SYSTEM_PASS in the API environment.
--
--     Why it is needed: some queries have no acting user and never will —
--     retention sweeps, presence fan-out, notification fan-out, invite-link
--     resolution (which by definition reads a chat you are not yet in), and
--     cross-user story access. Those run on db.SysPool (internal/db/db.go).
--     Without a BYPASSRLS role SysPool falls back to the user pool, and under
--     FORCE every one of them returns nothing.
--
--  4. Restart the API. A misconfigured system role makes it refuse to boot
--     rather than serve wrong data — that is deliberate.
--
-- ROLLBACK is one statement per table and takes effect immediately:
--     ALTER TABLE <t> NO FORCE ROW LEVEL SECURITY;
-- No data is touched by either direction.

ALTER TABLE chats        FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_members FORCE ROW LEVEL SECURITY;
ALTER TABLE messages     FORCE ROW LEVEL SECURITY;
ALTER TABLE attachments  FORCE ROW LEVEL SECURITY;

-- calls and call_participants are already FORCE'd by 066 — they were born that
-- way, having no legacy code path to break. Restated here so this file is the
-- single answer to "which tables are enforced", and because ALTER is a no-op
-- when the flag is already set.
ALTER TABLE calls             FORCE ROW LEVEL SECURITY;
ALTER TABLE call_participants FORCE ROW LEVEL SECURITY;
