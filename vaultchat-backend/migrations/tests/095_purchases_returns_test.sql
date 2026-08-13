-- 095_purchases_returns_test.sql — rehearses purchases, returns, credit notes
-- and the audit log (P1-A / P1-B / P1-F) against a copy of the real schema.
--
-- What only the database can answer: whether the audit log really refuses to
-- be rewritten, whether two returns can be opened on one order, and whether a
-- supplier invoice can be entered twice. Each is enforced by a constraint, and
-- a constraint that has never been fired is a guess.
--
-- Run against a throwaway copy of production's schema:
--   docker exec vaultchat-postgres-1 psql -U vaultchat -d sbtest -v ON_ERROR_STOP=1 -f <this file>
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name) VALUES
 ('11111111-0000-4000-8000-0000000000c1', '+910000000c01', 'Ret Owner'),
 ('11111111-0000-4000-8000-0000000000c2', '+910000000c02', 'Ret Customer')
ON CONFLICT DO NOTHING;

INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone, approved)
VALUES ('22222222-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c1',
        'Return Store', 'grocery', 'Nowhere', '+910000000c01', TRUE)
ON CONFLICT (owner_user_id) DO NOTHING;

INSERT INTO shopbook_product (id, shop_id, name, unit, price, track_stock)
VALUES ('44444444-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000c1',
        'Rice', '5kg', 300.00, TRUE) ON CONFLICT DO NOTHING;
INSERT INTO shopbook_stock (product_id, shop_id, on_hand)
VALUES ('44444444-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000c1', 5)
ON CONFLICT (product_id) DO UPDATE SET on_hand = 5, reserved = 0;

INSERT INTO shopbook_order (id, shop_id, customer_user_id, status, subtotal, tax_total, total)
VALUES ('33333333-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000c1',
        '11111111-0000-4000-8000-0000000000c2', 'completed', 600.00, 30.00, 630.00)
ON CONFLICT DO NOTHING;
INSERT INTO shopbook_order_item (id, order_id, product_id, name, unit, qty, price, tax_percent, line_total)
VALUES ('55555555-0000-4000-8000-0000000000c1', '33333333-0000-4000-8000-0000000000c1',
        '44444444-0000-4000-8000-0000000000c1', 'Rice', '5kg', 2, 300.00, 5, 630.00)
ON CONFLICT DO NOTHING;
INSERT INTO shopbook_invoice (id, shop_id, order_id, customer_user_id, number, total)
VALUES ('66666666-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000c1',
        '33333333-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c2', 1, 630.00)
ON CONFLICT DO NOTHING;

-- ── 1. the audit log cannot be rewritten by anyone ────────────────
-- An audit row the audited party can edit records nothing at all.
DO $$
DECLARE n INT;
BEGIN
  INSERT INTO shopbook_audit (shop_id, actor_user_id, action, entity, entity_id, reason)
  VALUES ('22222222-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c1',
          'product.price_change', 'product', '44444444-0000-4000-8000-0000000000c1', 'seasonal');

  BEGIN
    UPDATE shopbook_audit SET reason='nothing to see here'
     WHERE shop_id='22222222-0000-4000-8000-0000000000c1';
    RAISE EXCEPTION 'audit row was UPDATEable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'audit row was UPDATEable' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM shopbook_audit WHERE shop_id='22222222-0000-4000-8000-0000000000c1';
    RAISE EXCEPTION 'audit row was DELETEable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'audit row was DELETEable' THEN RAISE; END IF;
  END;

  SELECT COUNT(*) INTO n FROM shopbook_audit WHERE shop_id='22222222-0000-4000-8000-0000000000c1';
  IF n <> 1 THEN RAISE EXCEPTION 'audit rows = %, want 1 survivor', n; END IF;
  RAISE NOTICE 'audit log OK (append-only: UPDATE and DELETE both refused)';
END $$;

-- ── 2. a supplier invoice cannot be entered twice ─────────────────
DO $$
BEGIN
  INSERT INTO shopbook_purchase (shop_id, supplier_name, invoice_number, subtotal, total)
  VALUES ('22222222-0000-4000-8000-0000000000c1', 'Metro Wholesale', 'MW-8891', 1000, 1050);
  BEGIN
    INSERT INTO shopbook_purchase (shop_id, supplier_name, invoice_number, subtotal, total)
    VALUES ('22222222-0000-4000-8000-0000000000c1', 'metro wholesale', 'mw-8891', 1000, 1050);
    RAISE EXCEPTION 'the same supplier invoice was accepted twice';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- A different invoice from the same supplier is a different delivery.
  INSERT INTO shopbook_purchase (shop_id, supplier_name, invoice_number, subtotal, total)
  VALUES ('22222222-0000-4000-8000-0000000000c1', 'Metro Wholesale', 'MW-8892', 500, 525);
  -- And purchases with NO invoice number must not collide with each other.
  INSERT INTO shopbook_purchase (shop_id, supplier_name, subtotal, total)
  VALUES ('22222222-0000-4000-8000-0000000000c1', 'Cash Market', 200, 200),
         ('22222222-0000-4000-8000-0000000000c1', 'Cash Market', 300, 300);
  RAISE NOTICE 'purchase dedupe OK (case-insensitive, but only when numbered)';
END $$;

-- ── 3. one open return per order ──────────────────────────────────
DO $$
BEGIN
  INSERT INTO shopbook_return (id, shop_id, order_id, customer_user_id, reason)
  VALUES ('77777777-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000c1',
          '33333333-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c2', 'spoiled');
  BEGIN
    INSERT INTO shopbook_return (shop_id, order_id, customer_user_id, reason)
    VALUES ('22222222-0000-4000-8000-0000000000c1', '33333333-0000-4000-8000-0000000000c1',
            '11111111-0000-4000-8000-0000000000c2', 'double tap');
    RAISE EXCEPTION 'a second open return was accepted for the same order';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- Once the first is settled, a later genuine return may be raised.
  UPDATE shopbook_return SET status='completed' WHERE id='77777777-0000-4000-8000-0000000000c1';
  INSERT INTO shopbook_return (shop_id, order_id, customer_user_id, reason)
  VALUES ('22222222-0000-4000-8000-0000000000c1', '33333333-0000-4000-8000-0000000000c1',
          '11111111-0000-4000-8000-0000000000c2', 'second item also spoiled');
  RAISE NOTICE 'return dedupe OK (one open at a time, reopenable after settlement)';
END $$;

-- ── 4. credit note numbering is per shop, per kind ────────────────
DO $$
DECLARE n INT;
BEGIN
  INSERT INTO shopbook_credit_note
    (shop_id, invoice_id, customer_user_id, kind, number, total)
  VALUES ('22222222-0000-4000-8000-0000000000c1', '66666666-0000-4000-8000-0000000000c1',
          '11111111-0000-4000-8000-0000000000c2', 'credit', 1, 315.00);
  BEGIN
    INSERT INTO shopbook_credit_note
      (shop_id, invoice_id, customer_user_id, kind, number, total)
    VALUES ('22222222-0000-4000-8000-0000000000c1', '66666666-0000-4000-8000-0000000000c1',
            '11111111-0000-4000-8000-0000000000c2', 'credit', 1, 100.00);
    RAISE EXCEPTION 'credit note number 1 was issued twice';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- A DEBIT note runs its own series and may also be number 1.
  INSERT INTO shopbook_credit_note
    (shop_id, invoice_id, customer_user_id, kind, number, total)
  VALUES ('22222222-0000-4000-8000-0000000000c1', '66666666-0000-4000-8000-0000000000c1',
          '11111111-0000-4000-8000-0000000000c2', 'debit', 1, 50.00);

  SELECT COUNT(*) INTO n FROM shopbook_credit_note
   WHERE shop_id='22222222-0000-4000-8000-0000000000c1';
  IF n <> 2 THEN RAISE EXCEPTION 'credit notes = %, want 2', n; END IF;

  -- The original invoice is untouched. That is the entire point of a credit
  -- note, and the reason returns do not edit history.
  SELECT total INTO n FROM shopbook_invoice WHERE id='66666666-0000-4000-8000-0000000000c1';
  IF n <> 630 THEN RAISE EXCEPTION 'the invoice was altered by the credit note (now %)', n; END IF;
  RAISE NOTICE 'credit notes OK (per-kind series, invoice left intact)';
END $$;

-- ── 5. refunds are a ledger type, not a negative purchase ─────────
DO $$
BEGIN
  INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark)
  VALUES ('22222222-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c2',
          'credit_note', 315.00, 'Return credited'),
         ('22222222-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c2',
          'refund', 100.00, 'Return refunded');
  BEGIN
    INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount)
    VALUES ('22222222-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c2',
            'purchase', -315.00);
    RAISE EXCEPTION 'a negative purchase was accepted as a refund';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'ledger types OK (credit_note/refund exist, sign-flip still refused)';
END $$;

-- ── 6. weighted average cost ──────────────────────────────────────
-- 5 @ 200 then 5 @ 300 must average to 250 — not 300, and not 250 by luck.
DO $$
DECLARE avg_now NUMERIC; qty_now NUMERIC;
BEGIN
  UPDATE shopbook_product SET avg_cost = 200, avg_cost_qty = 5
   WHERE id='44444444-0000-4000-8000-0000000000c1';
  UPDATE shopbook_product
     SET avg_cost = ROUND((avg_cost*avg_cost_qty + 300*5) / (avg_cost_qty + 5), 2),
         avg_cost_qty = avg_cost_qty + 5
   WHERE id='44444444-0000-4000-8000-0000000000c1';
  SELECT avg_cost, avg_cost_qty INTO avg_now, qty_now
    FROM shopbook_product WHERE id='44444444-0000-4000-8000-0000000000c1';
  IF avg_now <> 250 THEN RAISE EXCEPTION 'avg cost = %, want 250', avg_now; END IF;
  IF qty_now <> 10 THEN RAISE EXCEPTION 'avg cost qty = %, want 10', qty_now; END IF;
  RAISE NOTICE 'weighted average cost OK (5@200 + 5@300 = 250 over 10)';
END $$;

ROLLBACK;
