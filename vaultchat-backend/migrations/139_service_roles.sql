-- 139_service_roles.sql — one database login per feature service, and the
-- membership view Family Space and Calls read instead of copying membership.
--
-- openspec: microservices-prepare. docs/MICROSERVICES_PLAN.html, rules "Own
-- tables, own login" and "Read membership live, never copy it".
--
-- APPLYING THIS CHANGES NOTHING, for the same reason as 133: every role is
-- created NOLOGIN with no password, so nothing can connect as one, and a grant
-- to a role nobody runs as cannot change a query. The API keeps connecting as
-- it does today. A role is armed only when its service moves out, by an
-- operator, outside the migration runner:
--
--     ALTER ROLE svc_golive LOGIN PASSWORD '<generated>';
--
-- and then only takes effect once that service's container sets DB_USER to it.
--
-- WHAT EACH ROLE GETS
-- -------------------
-- SELECT/INSERT/UPDATE/DELETE on its own tables, USAGE on their sequences, and
-- nothing else: no other service's tables, no users, no schema changes. To
-- change another service's data, call that service. Account deletion still
-- reaches service tables because their foreign keys to users(id) cascade, and a
-- cascade runs with the table owner's rights, not the deleting role's.
--
-- BYPASSRLS, like vaultchat_sys in 133. RLS is inert in production (the API is
-- the owning superuser) and every handler scopes by user itself; these roles
-- keep exactly those semantics. What they add is table isolation.
--
-- Maps has a role and no tables: it runs Valhalla and Photon, and owning
-- nothing is the point.
--
-- ROLLBACK (commented; the real rollback is simply not arming a role):
--
--     -- DROP VIEW IF EXISTS chat_membership;
--     -- DROP OWNED BY svc_golive, svc_family, svc_games, svc_maps, svc_shopbook, svc_calls;
--     -- DROP ROLE IF EXISTS svc_golive, svc_family, svc_games, svc_maps, svc_shopbook, svc_calls;

-- ── The roles ──────────────────────────────────────────────────────
-- Attributes re-asserted on every run, LOGIN and PASSWORD left alone, so a
-- re-run corrects a role someone widened but never disarms an armed one.
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['svc_golive','svc_family','svc_games','svc_maps','svc_shopbook','svc_calls'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
    EXECUTE format('ALTER ROLE %I NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT', r);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO svc_golive, svc_family, svc_games, svc_maps, svc_shopbook, svc_calls;

-- ── Tables per service ─────────────────────────────────────────────
-- Named, not pattern-matched, except ShopBook's 31 tables which all share the
-- shopbook_ prefix and nothing else does. A table added later needs its own
-- grant in the migration that adds it.
DO $$
DECLARE
  owned JSONB := jsonb_build_object(
    'svc_golive', jsonb_build_array(
      'broadcast_sessions','broadcast_invites','broadcast_invite_links',
      'broadcast_chat','broadcast_comments','broadcast_likes',
      'broadcast_polls','broadcast_poll_votes','broadcast_viewers'),
    'svc_family', jsonb_build_array(
      'space_attendance','space_device_commands','space_device_events',
      'space_devices','space_incidents','space_items','space_leave',
      'space_links','space_locations','space_roster','space_tasks','space_trips',
      'runs','run_events','run_riders','run_stops',
      'family_relations','visitor_passes','sos_events','trusted_contacts'),
    'svc_games', jsonb_build_array(
      'games_matches','games_live_tables','games_notify_seen'),
    'svc_calls', jsonb_build_array(
      'calls','call_invites','call_participants'),
    'svc_shopbook', (SELECT jsonb_agg(tablename ORDER BY tablename)
                       FROM pg_tables
                      WHERE schemaname = 'public' AND tablename LIKE 'shopbook\_%'));
  role_name TEXT;
  tables JSONB;
  t TEXT;
  seq TEXT;
BEGIN
  FOR role_name, tables IN SELECT * FROM jsonb_each(owned) LOOP
    FOR t IN SELECT jsonb_array_elements_text(tables) LOOP
      IF to_regclass(format('public.%I', t)) IS NULL THEN
        RAISE EXCEPTION '139: % should own %, which does not exist', role_name, t;
      END IF;
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I', t, role_name);
      -- Sequences behind serial and identity columns: without USAGE an INSERT
      -- fails on nextval, a path nobody tests until the service moves.
      FOR seq IN
        SELECT s.relname
          FROM pg_class s
          JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
          JOIN pg_class c ON c.oid = d.refobjid
         WHERE s.relkind = 'S' AND c.relname = t
           AND c.relnamespace = 'public'::regnamespace
      LOOP
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', seq, role_name);
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- ── The membership view ────────────────────────────────────────────
-- Core owns membership. A service that kept its own copy would let someone
-- removed from a family keep seeing live locations until the copy caught up;
-- reading this view makes a removal effective on the member's next request.
-- Read-only through its grants: the roles get SELECT and nothing else. (A
-- single-table view like this one IS auto-updatable in PostgreSQL, so the
-- grant is the whole protection; tests/139 checks an UPDATE is refused.)
CREATE OR REPLACE VIEW chat_membership AS
SELECT chat_id, user_id, role, joined_at
  FROM chat_members
 WHERE left_at IS NULL;

GRANT SELECT ON chat_membership TO svc_family, svc_calls;

-- ── Refuse rather than report ──────────────────────────────────────
-- A superuser service role, or one that owns a table, would make all of the
-- above decorative while looking like a finished migration.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(rolname, ', ') INTO bad
    FROM pg_roles
   WHERE rolname LIKE 'svc\_%' AND rolsuper;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '139: service roles must not be superusers (%)', bad;
  END IF;

  SELECT string_agg(tablename, ', ') INTO bad
    FROM pg_tables
   WHERE schemaname = 'public' AND tableowner LIKE 'svc\_%';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '139: service roles must own nothing (%)', bad;
  END IF;
END $$;
