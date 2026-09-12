-- 128 — let a NON-SUPERUSER app role manage message_bodies partitions.
--
-- WHY
-- ---
-- The API connects to production as `vaultchat`: a SUPERUSER, with BYPASSRLS,
-- that owns all 170 tables. Every one of the 31 RLS-enabled tables (27 of them
-- FORCE ROW LEVEL SECURITY) is therefore inert — the policies are real, they
-- are just never consulted, and `SET LOCAL app.current_user_id` defends
-- nothing. The handler checks are the only control in force.
--
-- Fixing that means running as an unprivileged role. Rehearsing it against a
-- scratch database with a real NOSUPERUSER/NOBYPASSRLS role found exactly one
-- thing that stops working, and it is not a policy:
--
--     ERROR: must be owner of table message_bodies  (SQLSTATE 42501)
--
-- Partition DDL requires OWNERSHIP of the parent. Not CREATE on the schema,
-- not BYPASSRLS — ownership, which is the one privilege an app role must not
-- have. So the hourly partition an incoming message needs could not be
-- created, and message sends would fail the moment the role changed. This is
-- the blocker, and it fails at 00:00 on the hour rather than at deploy time.
--
-- The fix is to let the two DDL operations run as the owner, and only those
-- two, through functions that validate their own arguments.
--
-- Nothing changes today: the current superuser connection already had these
-- rights. This removes the blocker ahead of the role change rather than
-- discovering it during one.

-- ── create ──────────────────────────────────────────────────────────
-- Identical body to 099; SECURITY DEFINER is the whole change. The argument is
-- a timestamp and the name is derived from it, so there is nothing a caller can
-- inject: every reachable outcome is "the partition for some hour exists".
--
-- search_path is pinned. A SECURITY DEFINER function without it runs whatever
-- the CALLER's search_path resolves `date_trunc` and `format` to, which is the
-- classic way one of these becomes a privilege escalation.
CREATE OR REPLACE FUNCTION vc_message_bodies_ensure_partition(p_ts TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  lo TIMESTAMPTZ;
  hi TIMESTAMPTZ;
  nm TEXT;
BEGIN
  lo := (date_trunc('hour', p_ts AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';
  hi := lo + INTERVAL '1 hour';
  nm := 'message_bodies_' || to_char(lo AT TIME ZONE 'UTC', 'YYYYMMDDHH24');
  BEGIN
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.message_bodies '
      'FOR VALUES FROM (%L) TO (%L)', nm, lo, hi);
  EXCEPTION WHEN duplicate_table THEN
    -- Two workers (or a worker and an on-demand insert) raced. IF NOT EXISTS
    -- checks the NAME, and the name is derived from the bounds, so whoever won
    -- created exactly the partition we wanted. Nothing to repair.
    NULL;
  END;
  RETURN nm;
END;
$fn$;

-- ── drop ────────────────────────────────────────────────────────────
-- The retention job used to build `DROP TABLE "<name>"` in Go. That is fine
-- while the connection owns the table and is impossible once it does not, so
-- the DDL moves here.
--
-- A SECURITY DEFINER function that drops a table named by its caller must not
-- trust that name, so this re-derives every precondition the job checks rather
-- than assuming the job checked them:
--
--   1. it is a partition OF message_bodies (pg_inherits, not the name);
--   2. its upper bound is in the past;
--   3. it is empty.
--
-- Returns TRUE if it dropped, FALSE if any precondition failed. A caller can
-- therefore never drop a live partition, another table that happens to be
-- named like one, or anything at all outside this one parent — which is why it
-- is safe to leave executable rather than gated on a role that does not exist
-- yet.
CREATE OR REPLACE FUNCTION vc_message_bodies_drop_partition(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  upper_bound TIMESTAMPTZ;
  has_rows BOOLEAN;
BEGIN
  SELECT (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamptz
    INTO upper_bound
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE i.inhparent = 'public.message_bodies'::regclass
     AND n.nspname = 'public'
     AND c.relname = p_name;

  IF upper_bound IS NULL THEN
    RETURN FALSE;  -- not a partition of message_bodies; nothing to do
  END IF;
  IF upper_bound > NOW() THEN
    RETURN FALSE;  -- still inside its window
  END IF;

  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)', p_name) INTO has_rows;
  IF has_rows THEN
    -- Past its window and still holding rows means the expiry sweep is behind.
    -- Dropping here would destroy messages that should have been expired
    -- individually and audited. Refuse; the job logs and alerts on FALSE.
    RETURN FALSE;
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS public.%I', p_name);
  RETURN TRUE;
END;
$fn$;

-- PUBLIC keeps EXECUTE because the app role does not exist yet and a GRANT to a
-- missing role fails the migration. Both functions validate everything they act
-- on, so the worst a caller can achieve is what the retention job would have
-- done on its next tick.
