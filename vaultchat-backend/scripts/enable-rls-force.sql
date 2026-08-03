-- enable-rls-force.sql — make the RLS policies actually apply.
--
--     psql "$DATABASE_URL" -f scripts/enable-rls-force.sql
--
-- Idempotent. Guarded: it REFUSES to run until the system role exists.
--
-- ⚠️  THIS IS NOT A MIGRATION, AND IT DELIBERATELY LIVES OUTSIDE migrations/.
--
-- It was numbered 068 at first, which was a mistake worth recording. deploy.sh
-- step 4 runs `node migrate.js up`, which applies EVERY pending file — so a
-- routine deploy would have enforced RLS with no system role configured, and
-- every retention sweep, presence fan-out, notification fan-out, invite-link
-- lookup and cross-user story read would have started returning zero rows.
-- Silently: no error, no crash, just an app that quietly stops doing half its
-- background work.
--
-- This is an OPERATIONAL SWITCH, not a schema change. It alters no data, and
-- its rollback is one statement per table. It should be thrown deliberately, by
-- a person who has read the checklist, not swept up by an automated run.
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

-- ── the guard ───────────────────────────────────────────────
-- Refuse to enforce RLS while every user-less query would break. This is the
-- same check the checklist asks for, made impossible to skip.
--
-- It looks for ANY role with BYPASSRLS other than superusers (who bypass
-- everything anyway and are not what the API connects as). If you named the
-- role something other than vaultchat_system, this still finds it.
DO $$
DECLARE
  sys_role TEXT;
BEGIN
  SELECT rolname INTO sys_role
    FROM pg_roles
   WHERE rolbypassrls AND NOT rolsuper AND rolcanlogin
   LIMIT 1;

  IF sys_role IS NULL THEN
    RAISE EXCEPTION
      'refusing to force RLS: no BYPASSRLS login role exists%',
      E'\n\n'
      'Every query with no acting user — retention sweeps, presence and\n'
      'notification fan-out, invite-link lookup, cross-user story reads —\n'
      'would silently return zero rows.\n\n'
      'Create the role and point the API at it FIRST:\n'
      '    CREATE ROLE vaultchat_system LOGIN PASSWORD ''...'' BYPASSRLS;\n'
      '    GRANT ALL ON ALL TABLES IN SCHEMA public TO vaultchat_system;\n'
      '    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO vaultchat_system;\n'
      '    ALTER DEFAULT PRIVILEGES IN SCHEMA public\n'
      '      GRANT ALL ON TABLES TO vaultchat_system;\n\n'
      'then set DB_SYSTEM_USER / DB_SYSTEM_PASS and restart the API.\n'
      'See docs/RLS_ENFORCEMENT.md.';
  END IF;

  RAISE NOTICE 'system role found: % — enforcing RLS', sys_role;
END $$;

ALTER TABLE chats        FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_members FORCE ROW LEVEL SECURITY;
ALTER TABLE messages     FORCE ROW LEVEL SECURITY;
ALTER TABLE attachments  FORCE ROW LEVEL SECURITY;

-- calls and call_participants are already FORCE'd by 066 (safe there: they are
-- new tables with no legacy code path, so nothing can regress) — they were born that
-- way, having no legacy code path to break. Restated here so this file is the
-- single answer to "which tables are enforced", and because ALTER is a no-op
-- when the flag is already set.
ALTER TABLE calls             FORCE ROW LEVEL SECURITY;
ALTER TABLE call_participants FORCE ROW LEVEL SECURITY;
