-- 083_not_collected_test.sql — rehearses the collection-handoff SQL against a
-- copy of the real schema (openspec: shop-book-upgrade, D5a).
--
-- The 24h gate and the 7-day sweep are hand-written SQL with correlated
-- subqueries that no Go unit test executes — the transition table is pure data,
-- but these two statements only fail when a real planner runs them against real
-- columns. So they get rehearsed here. Everything runs in a transaction that
-- ends in ROLLBACK; the fixtures never persist.
--
-- Run against a throwaway copy of production's schema:
--   docker exec vaultchat-postgres-1 sh -c 'pg_dump -U vaultchat -s vaultchat > /tmp/s.sql'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d postgres -c 'CREATE DATABASE sbtest'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d sbtest -q -f /tmp/s.sql
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d sbtest -v ON_ERROR_STOP=1 -f <this file>
--
-- Every assertion raises, so a non-zero exit means a real failure.
\set ON_ERROR_STOP on

-- Fixtures: one shop owner, one customer, one shop, three ready orders of
-- different ages. Wrapped so the whole rehearsal leaves nothing behind.
BEGIN;

INSERT INTO users (id, phone, name)
VALUES ('11111111-0000-4000-8000-000000000001', '+910000000001', 'Test Owner'),
       ('11111111-0000-4000-8000-000000000002', '+910000000002', 'Test Customer');

INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone)
VALUES ('22222222-0000-4000-8000-000000000001',
        '11111111-0000-4000-8000-000000000001',
        'Rehearsal Store', 'grocery', 'Nowhere', '+910000000001');

-- ready 2h ago / 30h ago / 8 days ago
INSERT INTO shopbook_order (id, shop_id, customer_user_id, status, total, updated_at)
VALUES ('33333333-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-000000000001',
        '11111111-0000-4000-8000-000000000002', 'ready', 100, NOW() - INTERVAL '2 hours'),
       ('33333333-0000-4000-8000-00000000000b', '22222222-0000-4000-8000-000000000001',
        '11111111-0000-4000-8000-000000000002', 'ready', 200, NOW() - INTERVAL '30 hours'),
       ('33333333-0000-4000-8000-00000000000c', '22222222-0000-4000-8000-000000000001',
        '11111111-0000-4000-8000-000000000002', 'ready', 300, NOW() - INTERVAL '8 days');

INSERT INTO shopbook_order_event (order_id, status, at) VALUES
  ('33333333-0000-4000-8000-00000000000a', 'ready', NOW() - INTERVAL '2 hours'),
  ('33333333-0000-4000-8000-00000000000b', 'ready', NOW() - INTERVAL '30 hours'),
  -- 'c' deliberately has NO ready event: exercises the updated_at fallback for
  -- rows that predate the timeline table.
  ('33333333-0000-4000-8000-00000000000a', 'packing', NOW() - INTERVAL '3 hours');

-- ── 1. sbReadyFor: the 24h gate ───────────────────────────────────
DO $$
DECLARE h NUMERIC;
BEGIN
  -- the exact query sbReadyFor runs, per order
  SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(
           (SELECT MAX(at) FROM shopbook_order_event
             WHERE order_id=o.id AND status='ready'), o.updated_at)))/3600
    INTO h FROM shopbook_order o WHERE o.id='33333333-0000-4000-8000-00000000000a';
  IF h < 1.9 OR h > 2.1 THEN
    RAISE EXCEPTION 'gate: 2h-old order measured % hours', h;
  END IF;
  IF h >= 24 THEN RAISE EXCEPTION 'gate: 2h-old order would be writable off'; END IF;

  SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(
           (SELECT MAX(at) FROM shopbook_order_event
             WHERE order_id=o.id AND status='ready'), o.updated_at)))/3600
    INTO h FROM shopbook_order o WHERE o.id='33333333-0000-4000-8000-00000000000b';
  IF h < 24 THEN RAISE EXCEPTION 'gate: 30h-old order measured % hours, should pass', h; END IF;

  -- fallback path: no ready event, dates from updated_at
  SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(
           (SELECT MAX(at) FROM shopbook_order_event
             WHERE order_id=o.id AND status='ready'), o.updated_at)))/3600
    INTO h FROM shopbook_order o WHERE o.id='33333333-0000-4000-8000-00000000000c';
  IF h < 190 THEN RAISE EXCEPTION 'gate: updated_at fallback measured % hours', h; END IF;
  RAISE NOTICE 'gate OK (2h blocked, 30h allowed, no-event row falls back to updated_at)';
END $$;

-- ── 2. the sweep ──────────────────────────────────────────────────
-- Wrapped in a CTE only so the harness can keep the RETURNING rows; the Go
-- job runs the UPDATE … RETURNING statement directly.
CREATE TEMP TABLE swept AS
WITH s AS (
  UPDATE shopbook_order o
     SET status='not_collected', not_collected_reason='expired', updated_at=NOW()
   WHERE o.status='ready'
     AND COALESCE((SELECT MAX(at) FROM shopbook_order_event e
                    WHERE e.order_id=o.id AND e.status='ready'), o.updated_at)
         < NOW() - '168 hours'::interval
  RETURNING o.id, o.customer_user_id,
            (SELECT owner_user_id FROM shopbook_shop WHERE id=o.shop_id) AS owner_id
) SELECT * FROM s;

DO $$
DECLARE n INT; oid UUID; own UUID;
BEGIN
  SELECT COUNT(*) INTO n FROM swept;
  IF n <> 1 THEN RAISE EXCEPTION 'sweep: expected 1 order, swept %', n; END IF;

  SELECT id, owner_id INTO oid, own FROM swept;
  IF oid <> '33333333-0000-4000-8000-00000000000c' THEN
    RAISE EXCEPTION 'sweep: took the wrong order %', oid;
  END IF;
  IF own <> '11111111-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'sweep: owner lookup returned %', own;
  END IF;

  -- the 2h and 30h orders must survive: 30h is past the owner's 24h gate but
  -- nowhere near the 7-day sweep, and sweeping it would steal the customer's
  -- window to come and collect.
  SELECT COUNT(*) INTO n FROM shopbook_order WHERE status='ready';
  IF n <> 2 THEN RAISE EXCEPTION 'sweep: % ready orders left, expected 2', n; END IF;

  SELECT COUNT(*) INTO n FROM shopbook_order
   WHERE status='not_collected' AND not_collected_reason='expired';
  IF n <> 1 THEN RAISE EXCEPTION 'sweep: reason not stamped'; END IF;
  RAISE NOTICE 'sweep OK (1 expired, 2 still waiting, reason + owner resolved)';
END $$;

-- ── 3. an uncollected order must never look like revenue ──────────
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM shopbook_ledger
   WHERE order_id='33333333-0000-4000-8000-00000000000c';
  IF n <> 0 THEN RAISE EXCEPTION 'not_collected posted % ledger rows', n; END IF;
  SELECT COUNT(*) INTO n FROM shopbook_invoice
   WHERE order_id='33333333-0000-4000-8000-00000000000c';
  IF n <> 0 THEN RAISE EXCEPTION 'not_collected issued % invoices', n; END IF;

  -- and it must not reach the owner dashboard's open-order count
  SELECT COUNT(*) INTO n FROM shopbook_order
   WHERE shop_id='22222222-0000-4000-8000-000000000001'
     AND status IN ('new','preparing','packing','ready');
  IF n <> 2 THEN RAISE EXCEPTION 'dashboard open-orders = %, expected 2', n; END IF;

  -- nor the completed-sales report
  SELECT COUNT(*) INTO n FROM shopbook_order
   WHERE shop_id='22222222-0000-4000-8000-000000000001' AND status='completed';
  IF n <> 0 THEN RAISE EXCEPTION 'uncollected order counted as completed sales'; END IF;
  RAISE NOTICE 'accounting OK (no ledger, no invoice, off the dashboard and reports)';
END $$;

ROLLBACK;
