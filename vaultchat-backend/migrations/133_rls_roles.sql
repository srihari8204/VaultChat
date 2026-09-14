-- 133_rls_roles.sql — create the two non-owner roles that make RLS real.
--
-- APPLYING THIS CHANGES NOTHING. Both roles are created NOLOGIN with no
-- password, so nothing can connect as them. A role that cannot be connected as
-- cannot change one query's behaviour. The grants below are likewise inert
-- until a session actually runs as one of these roles. This file is therefore
-- safe to sweep up in a routine `node migrate.js up` — which is precisely why
-- the enforcement half (scripts/enable-rls-force.sql, and the env flip) is NOT
-- a migration and must never become one.
--
-- WHY THIS EXISTS
-- ---------------
-- The API connects as `vaultchat`, which the postgres image creates as the
-- bootstrap SUPERUSER, and which — because migrations run as it — owns every
-- table. PostgreSQL exempts BOTH superusers and a table's owner from that
-- table's policies (the owner exemption is liftable with FORCE ROW LEVEL
-- SECURITY; the superuser exemption is NOT liftable by anything). So all 33
-- RLS-enabled tables in this repo are bypassed today, including `call_invites`,
-- the one table a migration marks FORCE. `db.WithUser`'s
-- `SET LOCAL app.current_user_id` sets a variable no policy is ever consulted
-- about. Verify before believing: see docs/RLS_ENFORCEMENT.md § Enforcement
-- plan, step 0.
--
-- NEITHER ROLE OWNS ANYTHING, and that is the entire point. An "app" role that
-- owned these tables would be exactly as bypassed as the superuser is now, and
-- would look completely correct in `\du`.
--
-- TWO ROLES, mirroring the two pools internal/db/db.go already has:
--
--   vaultchat_app  NOSUPERUSER NOBYPASSRLS — the request path (db.Pool).
--                  Policies apply. This is the role they were written for.
--   vaultchat_sys  NOSUPERUSER BYPASSRLS   — sweeps, presence fan-out,
--                  retention, invite-link resolution (db.SysPool). Work that
--                  belongs to no user and must see rows no user may see.
--
-- RELATIONSHIP TO scripts/rls-roles.sql
-- ------------------------------------
-- That script does the same thing by hand and is what created these roles on
-- the live box. It is not reproducible: it is not in the migration sequence, it
-- needs psql meta-commands (\gset, \if) that `migrate.js` cannot run, and
-- grants for every table added since exist only because someone remembered to
-- re-run it. docs/REBUILD_RISKS.md §6 flags exactly that. This migration takes
-- over the create-and-grant half so a rebuilt database has the roles without
-- anyone remembering; the script stays useful for setting the passwords.
--
-- THE ONE MANUAL STEP (deliberately not here)
-- -------------------------------------------
-- Passwords. A migration cannot hold a secret, and a role that can log in is
-- the only part of this that is not inert. To arm the roles, an operator runs
-- ONE statement each, outside the migration runner:
--
--     ALTER ROLE vaultchat_app LOGIN PASSWORD '<generated>';
--     ALTER ROLE vaultchat_sys LOGIN PASSWORD '<generated>';
--
-- Even that changes nothing until DB_USER/DB_SYSTEM_USER are repointed and the
-- API restarts.
--
-- PREREQUISITE, ALREADY LANDED: migration 128. Creating or dropping a partition
-- requires OWNERSHIP of the parent — not CREATE on the schema, not BYPASSRLS.
-- Neither role has it and neither should. 128 moved both into SECURITY DEFINER
-- functions. Without it message sends start failing on the hour rather than at
-- deploy time, which is the worst possible way to find out.
--
-- ROLLBACK (commented, because dropping a role in use locks up a live API):
--
--     -- Revoke first: DROP ROLE fails while any grant or default ACL names it.
--     -- REASSIGN OWNED is NOT needed — these roles own nothing, by design.
--     -- ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
--     --   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM vaultchat_app, vaultchat_sys;
--     -- ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
--     --   REVOKE USAGE, SELECT ON SEQUENCES FROM vaultchat_app, vaultchat_sys;
--     -- ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
--     --   REVOKE EXECUTE ON FUNCTIONS FROM vaultchat_app, vaultchat_sys;
--     -- DROP OWNED BY vaultchat_app, vaultchat_sys;   -- drops their grants only
--     -- DROP ROLE IF EXISTS vaultchat_app;
--     -- DROP ROLE IF EXISTS vaultchat_sys;
--     --
--     -- But the real rollback for a bad cutover is NOT this. It is putting
--     -- DB_USER back to `vaultchat`, unsetting DB_SYSTEM_USER/DB_RLS_ENFORCE
--     -- and restarting: under a minute, no schema change, no data touched.
--     -- Leave the roles in place for the next attempt.

-- ── The roles ──────────────────────────────────────────────────────
-- NOLOGIN and passwordless on purpose (see header). `IF NOT EXISTS` does not
-- exist for CREATE ROLE, hence the DO block.
--
-- The attribute list is re-asserted on every run rather than only at creation,
-- so a role that someone has since granted SUPERUSER or BYPASSRLS is corrected
-- by the next migrate — but LOGIN and PASSWORD are deliberately left alone, so
-- re-running this never disarms a deployment that has already cut over.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vaultchat_app') THEN
    CREATE ROLE vaultchat_app NOLOGIN;
  END IF;
  ALTER ROLE vaultchat_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vaultchat_sys') THEN
    CREATE ROLE vaultchat_sys NOLOGIN;
  END IF;
  -- BYPASSRLS is the whole reason this second role exists. Without it every
  -- user-less query — retention sweeps, presence fan-out, invite resolution —
  -- returns zero rows the instant policies start applying, silently.
  ALTER ROLE vaultchat_sys NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
END $$;

-- ── Privileges on what exists now ──────────────────────────────────
-- Data access only. No CREATE on the schema, no ownership, no TRUNCATE: an app
-- role that can reshape the schema is a different kind of problem.
GRANT USAGE ON SCHEMA public TO vaultchat_app, vaultchat_sys;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO vaultchat_app, vaultchat_sys;
GRANT USAGE, SELECT                 ON ALL SEQUENCES  IN SCHEMA public TO vaultchat_app, vaultchat_sys;
GRANT EXECUTE                       ON ALL FUNCTIONS  IN SCHEMA public TO vaultchat_app, vaultchat_sys;

-- ── Privileges on what later migrations create ─────────────────────
-- ALTER DEFAULT PRIVILEGES applies to objects created by the role named in
-- FOR ROLE, so it must name whoever runs migrations. scripts/rls-roles.sql
-- hardcodes `vaultchat`; current_user is correct on any box, including CI and a
-- rebuilt one. FOR ROLE takes no expression, so it goes through format().
--
-- Without this, the first table a future migration adds is a
-- `permission denied` on a path nobody tested — and only after the cutover, so
-- it reads as a cutover bug rather than a missing grant.
DO $$
DECLARE owner TEXT := quote_ident(current_user);
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public '
                 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vaultchat_app, vaultchat_sys', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public '
                 'GRANT USAGE, SELECT ON SEQUENCES TO vaultchat_app, vaultchat_sys', owner);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public '
                 'GRANT EXECUTE ON FUNCTIONS TO vaultchat_app, vaultchat_sys', owner);
END $$;

-- ── Refuse rather than report ──────────────────────────────────────
-- A privileged "app" role, or one that owns a table, makes every policy in this
-- database inert while looking like a completed migration. That is the exact
-- failure this whole file exists to prevent, so it aborts the transaction.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(rolname, ', ') INTO bad
    FROM pg_roles
   WHERE rolname = 'vaultchat_app' AND (rolsuper OR rolbypassrls);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'vaultchat_app is privileged (%); RLS would not apply to it', bad;
  END IF;

  SELECT string_agg(tablename, ', ') INTO bad
    FROM pg_tables
   WHERE schemaname = 'public' AND tableowner IN ('vaultchat_app', 'vaultchat_sys');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'the RLS roles own tables (%); an owner is exempt from its own policies', bad;
  END IF;
END $$;
