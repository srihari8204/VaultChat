-- 093_inventory_test.sql — rehearses stock reservation (P0-B), including the
-- concurrency case that is the entire reason this subsystem exists.
--
-- The oversell test CANNOT be written as a Go unit test: it is a claim about
-- what the guarded UPDATE does against a real row, with a real planner.
--
-- What it proves, precisely: given 2 on hand, two successive attempts to
-- reserve 2 produce one success and one refusal. Under genuine simultaneity
-- Postgres serialises the two UPDATEs on the row lock and the loser re-checks
-- `reserved + q <= on_hand` against the winner's committed value — which is
-- the case rehearsed below. What is NOT proven here is that the application
-- aborts its transaction on the refusal; that lives in sbApplyMove's
-- ok=false path and needs a running API to exercise.
--
-- Run against a throwaway copy of production's schema:
--   docker exec vaultchat-postgres-1 sh -c 'pg_dump -U vaultchat -s vaultchat > /tmp/s.sql'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d postgres -c 'CREATE DATABASE sbtest'
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d sbtest -q -f /tmp/s.sql
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d sbtest -v ON_ERROR_STOP=1 -f <this file>
--
-- Every assertion raises, so a non-zero exit means a real failure.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name)
VALUES ('11111111-0000-4000-8000-0000000000b1', '+910000000b01', 'Stock Owner'),
       ('11111111-0000-4000-8000-0000000000b2', '+910000000b02', 'Customer A'),
       ('11111111-0000-4000-8000-0000000000b3', '+910000000b03', 'Customer B');

INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone, plan)
VALUES ('22222222-0000-4000-8000-0000000000b1',
        '11111111-0000-4000-8000-0000000000b1',
        'Stock Store', 'grocery', 'Nowhere', '+910000000b01', 'pro');

INSERT INTO shopbook_product (id, shop_id, name, unit, price, track_stock)
VALUES ('44444444-0000-4000-8000-0000000000b1', '22222222-0000-4000-8000-0000000000b1',
        'Rice', '5kg', 300.00, TRUE),
       ('44444444-0000-4000-8000-0000000000b2', '22222222-0000-4000-8000-0000000000b1',
        'Chicken', '1kg', 240.00, TRUE);

INSERT INTO shopbook_stock (product_id, shop_id, on_hand, reorder_level)
VALUES ('44444444-0000-4000-8000-0000000000b1', '22222222-0000-4000-8000-0000000000b1', 2, 1),
       ('44444444-0000-4000-8000-0000000000b2', '22222222-0000-4000-8000-0000000000b1', 10, 2);

-- ── 1. available is derived, and cannot be written to ─────────────
DO $$
DECLARE a NUMERIC;
BEGIN
  SELECT available INTO a FROM shopbook_stock
   WHERE product_id='44444444-0000-4000-8000-0000000000b1';
  IF a <> 2 THEN RAISE EXCEPTION 'available = %, want 2', a; END IF;

  BEGIN
    UPDATE shopbook_stock SET available = 99
     WHERE product_id='44444444-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'available accepted a direct write — it must stay derived';
  EXCEPTION WHEN generated_always THEN
    NULL;
  END;
  RAISE NOTICE 'derived availability OK (2 available, direct write refused)';
END $$;

-- ── 2. the reservation guard ──────────────────────────────────────
-- This is the exact UPDATE sbApplyMove runs.
DO $$
DECLARE n INT; a NUMERIC;
BEGIN
  -- Customer A reserves both bags. Must succeed.
  UPDATE shopbook_stock
     SET reserved = reserved + 2
   WHERE product_id='44444444-0000-4000-8000-0000000000b1'
     AND reserved + 2 <= on_hand;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'reserve: customer A was refused 2 of 2'; END IF;

  -- Customer B asks for the same two. Must be refused — nothing is available.
  UPDATE shopbook_stock
     SET reserved = reserved + 2
   WHERE product_id='44444444-0000-4000-8000-0000000000b1'
     AND reserved + 2 <= on_hand;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'OVERSELL: customer B also reserved the last 2'; END IF;

  SELECT available INTO a FROM shopbook_stock
   WHERE product_id='44444444-0000-4000-8000-0000000000b1';
  IF a <> 0 THEN RAISE EXCEPTION 'available = % after full reservation, want 0', a; END IF;
  RAISE NOTICE 'reservation guard OK (A got 2, B refused, 0 available)';
END $$;

-- ── 3. the sane-position CHECK is the backstop ────────────────────
DO $$
BEGIN
  BEGIN
    UPDATE shopbook_stock SET reserved = reserved + 5
     WHERE product_id='44444444-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'reserved was allowed to exceed on_hand';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE shopbook_stock SET on_hand = -1
     WHERE product_id='44444444-0000-4000-8000-0000000000b2';
    RAISE EXCEPTION 'on_hand was allowed to go negative';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'position CHECK OK (no negative stock, no over-reservation)';
END $$;

-- ── 4. reserve → release → reserve again ──────────────────────────
DO $$
DECLARE n INT; a NUMERIC;
BEGIN
  UPDATE shopbook_stock SET reserved = reserved - 2
   WHERE product_id='44444444-0000-4000-8000-0000000000b1' AND reserved - 2 >= 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'release refused'; END IF;

  SELECT available INTO a FROM shopbook_stock
   WHERE product_id='44444444-0000-4000-8000-0000000000b1';
  IF a <> 2 THEN RAISE EXCEPTION 'available = % after release, want 2', a; END IF;

  -- Now customer B can have them, which is the point of releasing.
  UPDATE shopbook_stock SET reserved = reserved + 2
   WHERE product_id='44444444-0000-4000-8000-0000000000b1' AND reserved + 2 <= on_hand;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'B still refused after A released'; END IF;
  RAISE NOTICE 'release cycle OK (goods returned to the shelf and resold)';
END $$;

-- ── 5. sale consumes both shelf and hold ──────────────────────────
DO $$
DECLARE oh NUMERIC; rs NUMERIC;
BEGIN
  UPDATE shopbook_stock
     SET on_hand = on_hand - 2, reserved = reserved - 2
   WHERE product_id='44444444-0000-4000-8000-0000000000b1'
     AND on_hand - 2 >= 0 AND reserved - 2 >= 0;
  SELECT on_hand, reserved INTO oh, rs FROM shopbook_stock
   WHERE product_id='44444444-0000-4000-8000-0000000000b1';
  IF oh <> 0 OR rs <> 0 THEN
    RAISE EXCEPTION 'after sale on_hand=% reserved=%, want 0/0', oh, rs;
  END IF;
  RAISE NOTICE 'sale OK (shelf and hold both cleared)';
END $$;

-- ── 6. movements are write-once per order line ────────────────────
-- A retried accept must not reserve the same goods twice.
DO $$
DECLARE n INT;
BEGIN
  INSERT INTO shopbook_stock_movement
    (shop_id, product_id, kind, reserved_delta, ref_entity, ref_id)
  VALUES ('22222222-0000-4000-8000-0000000000b1', '44444444-0000-4000-8000-0000000000b2',
          'reservation', 3, 'order', '55555555-0000-4000-8000-0000000000b1');

  INSERT INTO shopbook_stock_movement
    (shop_id, product_id, kind, reserved_delta, ref_entity, ref_id)
  VALUES ('22222222-0000-4000-8000-0000000000b1', '44444444-0000-4000-8000-0000000000b2',
          'reservation', 3, 'order', '55555555-0000-4000-8000-0000000000b1')
  ON CONFLICT DO NOTHING;

  SELECT COUNT(*) INTO n FROM shopbook_stock_movement
   WHERE ref_id='55555555-0000-4000-8000-0000000000b1' AND kind='reservation';
  IF n <> 1 THEN RAISE EXCEPTION 'retry created % reservations for one order line', n; END IF;

  -- The matching release is a DIFFERENT kind and must still be allowed.
  INSERT INTO shopbook_stock_movement
    (shop_id, product_id, kind, reserved_delta, ref_entity, ref_id)
  VALUES ('22222222-0000-4000-8000-0000000000b1', '44444444-0000-4000-8000-0000000000b2',
          'reservation_release', -3, 'order', '55555555-0000-4000-8000-0000000000b1');

  -- Hand adjustments carry no reference and must never collide with each other.
  INSERT INTO shopbook_stock_movement
    (shop_id, product_id, kind, on_hand_delta, reason, ref_entity)
  VALUES ('22222222-0000-4000-8000-0000000000b1', '44444444-0000-4000-8000-0000000000b2',
          'damage', -1, 'dropped', 'adjustment'),
         ('22222222-0000-4000-8000-0000000000b1', '44444444-0000-4000-8000-0000000000b2',
          'damage', -1, 'dropped again', 'adjustment');
  RAISE NOTICE 'movement ledger OK (reserve-once, release allowed, adjustments free)';
END $$;

-- ── 7. the ledger reconciles with the running total ───────────────
-- shopbook_stock is a cache of Σ(movements). If they ever disagree, the cache
-- is lying and every availability decision downstream is wrong.
DO $$
DECLARE ledger NUMERIC; cached NUMERIC;
BEGIN
  UPDATE shopbook_stock SET on_hand = on_hand - 2
   WHERE product_id='44444444-0000-4000-8000-0000000000b2';   -- mirrors the 2 damage rows

  SELECT COALESCE(SUM(on_hand_delta),0) INTO ledger FROM shopbook_stock_movement
   WHERE product_id='44444444-0000-4000-8000-0000000000b2';
  SELECT on_hand - 10 INTO cached FROM shopbook_stock          -- 10 was the opening
   WHERE product_id='44444444-0000-4000-8000-0000000000b2';
  IF ledger <> cached THEN
    RAISE EXCEPTION 'movement ledger says % but the cached position moved %', ledger, cached;
  END IF;
  RAISE NOTICE 'ledger reconciles with the cached position (%)', ledger;
END $$;

-- ── 8. untracked products are untouched by any of this ────────────
DO $$
DECLARE n INT;
BEGIN
  INSERT INTO shopbook_product (id, shop_id, name, unit, price, in_stock)
  VALUES ('44444444-0000-4000-8000-0000000000b9', '22222222-0000-4000-8000-0000000000b1',
          'Loose Coriander', 'bunch', 10.00, TRUE);

  SELECT COUNT(*) INTO n FROM shopbook_stock
   WHERE product_id='44444444-0000-4000-8000-0000000000b9';
  IF n <> 0 THEN RAISE EXCEPTION 'an untracked product was given a stock row'; END IF;

  -- and it still reports availability the old way
  SELECT COUNT(*) INTO n FROM shopbook_product p
    LEFT JOIN shopbook_stock st ON st.product_id = p.id
   WHERE p.id='44444444-0000-4000-8000-0000000000b9'
     AND (CASE WHEN p.track_stock THEN COALESCE(st.available,0) > 0 ELSE p.in_stock END);
  IF n <> 1 THEN RAISE EXCEPTION 'untracked product stopped reporting in-stock'; END IF;
  RAISE NOTICE 'untracked products OK (no stock row, boolean still rules)';
END $$;

ROLLBACK;
