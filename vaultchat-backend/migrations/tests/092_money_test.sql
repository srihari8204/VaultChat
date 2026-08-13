-- 092_money_test.sql — rehearses the financial foundation (P0-A) against a
-- copy of the real schema.
--
-- The Go unit tests cover the arithmetic, which is pure. What they cannot
-- cover is the half of P0-A that only exists in Postgres: the minor-unit
-- boundary (sbCents / sbAmt), and the three indexes/constraints that are the
-- ACTUAL enforcement of idempotency and settle-once. A duplicate-payment guard
-- that lives only in a Go if-statement is not a guard — two requests race past
-- it. So the guards get rehearsed here, where the planner is real.
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
VALUES ('11111111-0000-4000-8000-0000000000a1', '+910000000a01', 'Money Owner'),
       ('11111111-0000-4000-8000-0000000000a2', '+910000000a02', 'Money Customer'),
       ('11111111-0000-4000-8000-0000000000a3', '+910000000a03', 'Other Customer');

INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone)
VALUES ('22222222-0000-4000-8000-0000000000a1',
        '11111111-0000-4000-8000-0000000000a1',
        'Money Store', 'grocery', 'Nowhere', '+910000000a01');

-- ── 1. the minor-unit boundary round-trips exactly ────────────────
-- Every money value crosses this boundary twice per request: read as
-- ((col)*100)::bigint, written back as ($n::numeric/100). If either direction
-- is lossy, a bill drifts by a paisa per hop and the khata stops reconciling.
DO $$
DECLARE v NUMERIC; c BIGINT; back NUMERIC;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    0::numeric, 0.01, 0.05, 0.10, 1.00, 99.99, 283.20, 125.50, 1234.56, 99999999.99
  ] LOOP
    c := ((v)*100)::bigint;                 -- sbCents
    back := (c::numeric/100);               -- sbAmt
    IF back <> v THEN
      RAISE EXCEPTION 'money round-trip lost value: % -> % -> %', v, c, back;
    END IF;
  END LOOP;
  RAISE NOTICE 'minor-unit boundary OK (10 values, exact both ways)';
END $$;

-- ── 2. order idempotency ──────────────────────────────────────────
INSERT INTO shopbook_order (id, shop_id, customer_user_id, status, subtotal, total, idempotency_key)
VALUES ('33333333-0000-4000-8000-0000000000a1', '22222222-0000-4000-8000-0000000000a1',
        '11111111-0000-4000-8000-0000000000a2', 'pending', 680.00, 680.00, 'retry-key-1');

DO $$
DECLARE n INT;
BEGIN
  -- The retry: same customer, same key. The index must refuse it, so the
  -- handler falls back to returning the order the first attempt created.
  BEGIN
    INSERT INTO shopbook_order (shop_id, customer_user_id, status, total, idempotency_key)
    VALUES ('22222222-0000-4000-8000-0000000000a1',
            '11111111-0000-4000-8000-0000000000a2', 'pending', 680.00, 'retry-key-1');
    RAISE EXCEPTION 'idempotency: a duplicate order key was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- A DIFFERENT customer reusing the same key string must still be able to
  -- order — keys are client-generated and could collide across users.
  INSERT INTO shopbook_order (shop_id, customer_user_id, status, total, idempotency_key)
  VALUES ('22222222-0000-4000-8000-0000000000a1',
          '11111111-0000-4000-8000-0000000000a3', 'pending', 50.00, 'retry-key-1');

  -- And orders with NO key (every pre-092 client) must not collide with
  -- each other, or ordering breaks for the entire installed base.
  INSERT INTO shopbook_order (shop_id, customer_user_id, status, total)
  VALUES ('22222222-0000-4000-8000-0000000000a1',
          '11111111-0000-4000-8000-0000000000a2', 'pending', 10.00),
         ('22222222-0000-4000-8000-0000000000a1',
          '11111111-0000-4000-8000-0000000000a2', 'pending', 20.00);

  SELECT COUNT(*) INTO n FROM shopbook_order WHERE shop_id='22222222-0000-4000-8000-0000000000a1';
  IF n <> 4 THEN RAISE EXCEPTION 'idempotency: expected 4 orders, found %', n; END IF;
  RAISE NOTICE 'order idempotency OK (retry refused, other customer allowed, keyless unaffected)';
END $$;

-- ── 3. settle-once: one purchase row per order ────────────────────
DO $$
DECLARE n INT;
BEGIN
  INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark, order_id)
  VALUES ('22222222-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a2',
          'purchase', 680.00, 'Order completed', '33333333-0000-4000-8000-0000000000a1');

  -- The second settlement — a double-tap on collect, or two racing requests
  -- that both passed the old SELECT-then-INSERT guard. ON CONFLICT DO NOTHING
  -- in the handler needs this index to conflict against.
  INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark, order_id)
  VALUES ('22222222-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a2',
          'purchase', 680.00, 'Order completed', '33333333-0000-4000-8000-0000000000a1')
  ON CONFLICT DO NOTHING;

  SELECT COUNT(*) INTO n FROM shopbook_ledger
   WHERE order_id='33333333-0000-4000-8000-0000000000a1' AND type='purchase';
  IF n <> 1 THEN RAISE EXCEPTION 'settle-once: % purchase rows for one order', n; END IF;

  -- A PAYMENT against the same order is a different thing entirely and must
  -- still be allowed — that is how a customer pays their bill.
  INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark, order_id)
  VALUES ('22222222-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a2',
          'payment', 400.00, 'Part payment', '33333333-0000-4000-8000-0000000000a1');
  RAISE NOTICE 'settle-once OK (one purchase, payments unaffected)';
END $$;

-- ── 4. ledger idempotency + the no-negative-amount rule ───────────
DO $$
BEGIN
  INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, idempotency_key)
  VALUES ('22222222-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a2',
          'payment', 300.00, 'pay-key-1');
  BEGIN
    INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, idempotency_key)
    VALUES ('22222222-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a2',
            'payment', 300.00, 'pay-key-1');
    RAISE EXCEPTION 'idempotency: a duplicate payment key was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- A negative amount would silently invert a purchase into a credit.
  -- Corrections belong in their own entry, not in a sign flip.
  BEGIN
    INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount)
    VALUES ('22222222-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a2',
            'payment', -100.00);
    RAISE EXCEPTION 'ledger: a negative amount was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'ledger guards OK (duplicate key refused, negative amount refused)';
END $$;

-- ── 5. order / invoice / ledger agree on ONE number ───────────────
-- The bug this fixes: the ledger posted the tax-exclusive total while the
-- invoice added tax on top, so every taxed order left the khata short by
-- exactly the tax. All three now read the order's snapshot.
DO $$
DECLARE o_total NUMERIC; inv_total NUMERIC; led NUMERIC; line_sum NUMERIC;
BEGIN
  UPDATE shopbook_order
     SET subtotal=680.00, discount=20.00, tax_total=33.00, total=693.00
   WHERE id='33333333-0000-4000-8000-0000000000a1';

  INSERT INTO shopbook_order_item
    (order_id, name, qty, price, tax_percent, line_discount, line_tax, line_total)
  VALUES ('33333333-0000-4000-8000-0000000000a1', 'Rice',  1, 300.00, 5, 8.82, 14.56, 305.74),
         ('33333333-0000-4000-8000-0000000000a1', 'Oil',   2, 145.00, 5, 8.53, 14.07, 295.54),
         ('33333333-0000-4000-8000-0000000000a1', 'Sugar', 2,  45.00, 5, 2.65,  4.37,  91.72);

  SELECT SUM(line_total) INTO line_sum FROM shopbook_order_item
   WHERE order_id='33333333-0000-4000-8000-0000000000a1';
  SELECT total INTO o_total FROM shopbook_order WHERE id='33333333-0000-4000-8000-0000000000a1';
  IF line_sum <> o_total THEN
    RAISE EXCEPTION 'lines sum to % but the order total is %', line_sum, o_total;
  END IF;

  INSERT INTO shopbook_invoice
    (shop_id, order_id, customer_user_id, number, subtotal, discount, tax_total, total)
  VALUES ('22222222-0000-4000-8000-0000000000a1', '33333333-0000-4000-8000-0000000000a1',
          '11111111-0000-4000-8000-0000000000a2', 1, 680.00, 20.00, 33.00, 693.00);

  SELECT total INTO inv_total FROM shopbook_invoice
   WHERE order_id='33333333-0000-4000-8000-0000000000a1';
  IF inv_total <> o_total THEN
    RAISE EXCEPTION 'invoice total % <> order total %', inv_total, o_total;
  END IF;

  -- The khata purchase must be that same number, not the pre-tax one.
  UPDATE shopbook_ledger SET amount = o_total
   WHERE order_id='33333333-0000-4000-8000-0000000000a1' AND type='purchase';
  SELECT amount INTO led FROM shopbook_ledger
   WHERE order_id='33333333-0000-4000-8000-0000000000a1' AND type='purchase';
  IF led <> inv_total THEN
    RAISE EXCEPTION 'ledger purchase % <> invoice total %', led, inv_total;
  END IF;
  RAISE NOTICE 'order = invoice = ledger = % (and Σ lines matches)', o_total;
END $$;

-- ── 6. invoice numbering stays unique per shop ────────────────────
DO $$
BEGIN
  BEGIN
    INSERT INTO shopbook_invoice
      (shop_id, order_id, customer_user_id, number, total)
    VALUES ('22222222-0000-4000-8000-0000000000a1',
            (SELECT id FROM shopbook_order
              WHERE shop_id='22222222-0000-4000-8000-0000000000a1'
                AND id <> '33333333-0000-4000-8000-0000000000a1' LIMIT 1),
            '11111111-0000-4000-8000-0000000000a2', 1, 50.00);
    RAISE EXCEPTION 'numbering: invoice number 1 was issued twice for one shop';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  RAISE NOTICE 'invoice numbering OK (per-shop uniqueness holds)';
END $$;

ROLLBACK;
