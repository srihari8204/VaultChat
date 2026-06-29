-- truncate-db.sql — wipe ALL application data, keep the schema intact.
--
-- ⚠️  DESTRUCTIVE & IRREVERSIBLE. Removes every row from every table in the
--     public schema EXCEPT `schema_migrations` (so migrations are NOT re-run).
--     Sequences are reset (RESTART IDENTITY); FKs are followed (CASCADE).
--
-- To KEEP specific tables too, add their names to the NOT IN (...) list below.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT IN ('schema_migrations')   -- keep the migration ledger
  LOOP
    EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', r.tablename);
  END LOOP;
END $$;

-- Show what's left (should all be 0 except schema_migrations).
SELECT relname AS table, n_live_tup AS rows
  FROM pg_stat_user_tables
 ORDER BY relname;
