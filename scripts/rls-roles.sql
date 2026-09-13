-- scripts/rls-roles.sql — create the roles that make RLS real.
--
-- AUDIT P1-05. Production connects as `vaultchat`: a SUPERUSER, with BYPASSRLS,
-- that owns all 170 tables. Every one of the 31 RLS-enabled tables (27 of them
-- FORCE ROW LEVEL SECURITY) is therefore inert — the policies are real, they are
-- just never consulted, and `db.WithUser`'s `SET LOCAL app.current_user_id`
-- defends nothing. Each handler's own WHERE clause is the only control in force,
-- which is exactly how the view-once bug shipped: that endpoint had no audience
-- check, and the surrounding WithUser wrapper made it look as though something
-- else was guarding it.
--
-- RUNNING THIS CHANGES NOTHING. Creating a role and granting it privileges has
-- no effect until something connects as it. The flip is one env change
-- (DB_USER / DB_SYSTEM_USER) plus a restart, and the rollback is the same
-- change back — see scripts/rls-flip.md. Staged separately so the risky step is
-- as small as possible and can be taken in a window rather than in a hurry.
--
-- TWO ROLES, mirroring internal/db/db.go, which already has both pools:
--
--   vaultchat_app  NOSUPERUSER NOBYPASSRLS — the request path (db.Pool). RLS
--                  applies. This is the role the policies exist for.
--   vaultchat_sys  NOSUPERUSER BYPASSRLS   — sweeps, fan-out, retention
--                  (db.SysPool). Work that belongs to no user and must see
--                  every row.
--
-- NEITHER OWNS ANYTHING, and that is the point: Postgres exempts a table's
-- OWNER from its own policies, so an app role that owned these tables would be
-- exactly as bypassed as the superuser is today.
--
-- Partition DDL is why migration 128 had to land first: creating or dropping a
-- partition requires OWNERSHIP of the parent, which neither role has and
-- neither should. 128 moves both operations into SECURITY DEFINER functions.
-- Without it, message sends start failing on the hour after the flip — not at
-- deploy time, which is the worst possible way to find out.
--
--   psql "$DATABASE_URL" -v app_pass="$APP_PASS" -v sys_pass="$SYS_PASS" -f scripts/rls-roles.sql
--
-- PASS THE RAW PASSWORD, WITH NO QUOTES OF YOUR OWN. `:'app_pass'` is psql's
-- quote-as-a-literal form, so it adds them. Passing "'secret'" stores a
-- password whose first and last characters are single quotes — which then
-- fails against every client that sends the password you thought you set.
-- That happened on the first run here, and it presented as
-- "SASL authentication failed" from PgBouncer, which points nowhere near the
-- cause.
--
-- Idempotent: safe to re-run, and re-running is how you pick up grants for
-- tables added by later migrations.

\set ON_ERROR_STOP on

-- CREATE-or-ALTER at the psql level, not inside a DO block. psql does NOT
-- substitute :'app_pass' inside a dollar-quoted body, so a DO block here fails
-- with a syntax error on the colon — which is how this was first written, and
-- how it first failed.
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vaultchat_app') AS need_app \gset
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vaultchat_sys') AS need_sys \gset

\if :need_app
CREATE ROLE vaultchat_app LOGIN PASSWORD :'app_pass' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
\else
ALTER ROLE vaultchat_app WITH LOGIN PASSWORD :'app_pass' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
\endif

\if :need_sys
CREATE ROLE vaultchat_sys LOGIN PASSWORD :'sys_pass' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
\else
ALTER ROLE vaultchat_sys WITH LOGIN PASSWORD :'sys_pass' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
\endif

-- Data privileges on everything that exists now.
GRANT USAGE ON SCHEMA public TO vaultchat_app, vaultchat_sys;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vaultchat_app, vaultchat_sys;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vaultchat_app, vaultchat_sys;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO vaultchat_app, vaultchat_sys;

-- And on everything a future migration creates, so a new table is not a silent
-- permission-denied the next time someone deploys. Default privileges apply to
-- objects created by the role named in FOR ROLE — the owner, which is who runs
-- migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE vaultchat IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vaultchat_app, vaultchat_sys;
ALTER DEFAULT PRIVILEGES FOR ROLE vaultchat IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vaultchat_app, vaultchat_sys;
ALTER DEFAULT PRIVILEGES FOR ROLE vaultchat IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO vaultchat_app, vaultchat_sys;

-- Prove the roles came out right. A privileged "app" role would make every
-- policy in this database inert while looking like a completed migration, so
-- this refuses rather than reports.
DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(rolname, ', ') INTO bad
    FROM pg_roles
   WHERE rolname = 'vaultchat_app' AND (rolsuper OR rolbypassrls);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'vaultchat_app is privileged (%), so RLS would not apply to it', bad;
  END IF;

  SELECT string_agg(tablename, ', ') INTO bad
    FROM pg_tables
   WHERE schemaname = 'public' AND tableowner IN ('vaultchat_app', 'vaultchat_sys');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'the app roles own tables (%), and an owner is exempt from its own policies', bad;
  END IF;
END $$;

SELECT rolname,
       rolsuper     AS superuser,
       rolbypassrls AS bypasses_rls
  FROM pg_roles
 WHERE rolname IN ('vaultchat', 'vaultchat_app', 'vaultchat_sys')
 ORDER BY rolname;
