-- check-rls.sql — is Row-Level Security actually in force on this deployment?
--
--   psql "$DATABASE_URL" -f scripts/check-rls.sql
--
-- READ-ONLY. Safe against production.
--
-- WHY THIS EXISTS
-- ---------------
-- 004_rls.sql says to verify the app role with `\du vaultchat_app`, which shows
-- the BYPASSRLS *attribute*. That is a necessary check but not a sufficient one:
-- Postgres also exempts a table's OWNER from its own policies unless the table
-- is set to FORCE ROW LEVEL SECURITY. So if the role the app connects as owns
-- these tables — which is the normal outcome when migrations are applied as
-- that role — every policy in 004_rls.sql is inert, and `\du` will not say so.
--
-- Demonstrated: a table owned by the connecting role, with a policy of
-- `USING (false)`, still returns its rows. Adding FORCE makes the same query
-- return none.
--
-- Read the output as:
--   rls_enabled = f          → no policies apply at all
--   rls_enabled = t,
--     rls_forced  = f,
--     owner = <the app role> → policies exist but are BYPASSED by the app
--   rls_enabled = t,
--     rls_forced  = f,
--     owner != app role      → policies apply (owner is someone else)
--   rls_enabled = t, rls_forced = t → policies apply unconditionally
--
-- Fixing an inert table is one statement:
--     ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
-- but do it deliberately, one table at a time, with the app exercised after
-- each: any server path that queries without SET app.current_user_id (system
-- fan-out, sweepers, workers) currently succeeds via owner-bypass and will
-- start returning zero rows the moment FORCE is set.

\echo '── Role attributes (is BYPASSRLS set?) ──'
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname = current_user OR rolname = 'vaultchat_app'
ORDER BY rolname;

\echo ''
\echo '── Per-table RLS state ──'
SELECT
  c.relname                                   AS table_name,
  pg_get_userbyid(c.relowner)                 AS owner,
  c.relrowsecurity                            AS rls_enabled,
  c.relforcerowsecurity                       AS rls_forced,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
  CASE
    WHEN NOT c.relrowsecurity                       THEN 'OFF — no policies apply'
    WHEN c.relforcerowsecurity                      THEN 'ENFORCED'
    WHEN pg_get_userbyid(c.relowner) = current_user THEN 'INERT — you own it and FORCE is off'
    ELSE 'enforced for you (you are not the owner)'
  END                                         AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND (c.relrowsecurity OR EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
ORDER BY c.relname;
