-- 110_documents_test.sql — rehearses the four-source invoice and the itemised
-- khata against a copy of the real schema.
--
-- What only the database can answer: whether a walk-in cash sale can exist with
-- no order and no customer, whether a 'khata' document can be created pointing
-- at no ledger entry, whether an issued invoice can be rewritten, and — the one
-- that nearly shipped broken — whether a shop can still be DELETED now that
-- its invoices refuse to change. Each is enforced by a constraint or a trigger,
-- and a constraint that has never been fired is a guess.
--
--   docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat \
--     -v ON_ERROR_STOP=1 -f - < this file
--
-- Self-cleaning: everything happens inside a transaction that is rolled back.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name) VALUES
 ('11111111-0000-4000-8000-0000000000d1', '+910000000d01', 'Doc Owner'),
 ('11111111-0000-4000-8000-0000000000d2', '+910000000d02', 'Doc Customer');

INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone, approved)
VALUES ('22222222-0000-4000-8000-0000000000d1', '11111111-0000-4000-8000-0000000000d1',
        'Doc Store', 'grocery', 'Pangidi', '+910000000d01', TRUE);

INSERT INTO shopbook_order (id, shop_id, customer_user_id, status, total)
VALUES ('33333333-0000-4000-8000-0000000000d1', '22222222-0000-4000-8000-0000000000d1',
        '11111111-0000-4000-8000-0000000000d2', 'completed', 630.00);

INSERT INTO shopbook_ledger (id, shop_id, customer_user_id, type, amount, remark)
VALUES ('77777777-0000-4000-8000-0000000000d1', '22222222-0000-4000-8000-0000000000d1',
        '11111111-0000-4000-8000-0000000000d2', 'purchase', 500.00, 'groceries');

-- ── 1. the khata can now say WHAT was given ───────────────────────
-- The whole point of the ledger_item table: "₹500, remark: groceries" becomes
-- priced lines the customer can check.
DO $$
DECLARE n INT;
BEGIN
  INSERT INTO shopbook_ledger_item (ledger_id, name, unit, qty, price, tax_percent) VALUES
    ('77777777-0000-4000-8000-0000000000d1', 'Rice',  '5kg', 1, 300.00, 5),
    ('77777777-0000-4000-8000-0000000000d1', 'Sugar', '1kg', 2, 100.00, 5);

  SELECT COUNT(*) INTO n FROM shopbook_ledger_item
   WHERE ledger_id='77777777-0000-4000-8000-0000000000d1';
  IF n <> 2 THEN RAISE EXCEPTION 'ledger items = %, want 2', n; END IF;
END $$;

-- ── 2. every source keeps its own key ─────────────────────────────
-- Without the CHECK these all succeed and produce documents pointing at
-- nothing — a failure that would only surface when rendering blew up.
DO $$
BEGIN
  BEGIN  -- khata document with no ledger entry behind it
    INSERT INTO shopbook_invoice (shop_id, customer_user_id, number, total, source)
    VALUES ('22222222-0000-4000-8000-0000000000d1',
            '11111111-0000-4000-8000-0000000000d2', 90, 1.00, 'khata');
    RAISE EXCEPTION 'khata invoice accepted with NULL ledger_id';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN  -- order document with no order behind it
    INSERT INTO shopbook_invoice (shop_id, customer_user_id, number, total, source)
    VALUES ('22222222-0000-4000-8000-0000000000d1',
            '11111111-0000-4000-8000-0000000000d2', 91, 1.00, 'order');
    RAISE EXCEPTION 'order invoice accepted with NULL order_id';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN  -- a walk-in is not an order; attaching one is a category error
    INSERT INTO shopbook_invoice (shop_id, order_id, number, total, source, walkin_name)
    VALUES ('22222222-0000-4000-8000-0000000000d1',
            '33333333-0000-4000-8000-0000000000d1', 92, 1.00, 'counter', 'Walk-in');
    RAISE EXCEPTION 'counter invoice accepted with an order_id';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN  -- unknown source
    INSERT INTO shopbook_invoice (shop_id, number, total, source, walkin_name)
    VALUES ('22222222-0000-4000-8000-0000000000d1', 93, 1.00, 'quotation', 'X');
    RAISE EXCEPTION 'unknown source accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ── 3. the capability this migration exists for ───────────────────
-- A cash sale to somebody who is not a VaultChat user and never placed an
-- order. Impossible before: order_id and customer_user_id were both NOT NULL.
DO $$
DECLARE n INT;
BEGIN
  INSERT INTO shopbook_invoice (shop_id, number, total, source, walkin_name, walkin_phone)
  VALUES ('22222222-0000-4000-8000-0000000000d1', 10, 120.00, 'counter',
          'Walk-in customer', '7793932101');

  SELECT COUNT(*) INTO n FROM shopbook_invoice
   WHERE shop_id='22222222-0000-4000-8000-0000000000d1' AND source='counter';
  IF n <> 1 THEN RAISE EXCEPTION 'counter invoice not stored (n=%)', n; END IF;
END $$;

-- khata + receipt documents, both legitimate
INSERT INTO shopbook_invoice (shop_id, ledger_id, customer_user_id, number, total, source)
VALUES ('22222222-0000-4000-8000-0000000000d1', '77777777-0000-4000-8000-0000000000d1',
        '11111111-0000-4000-8000-0000000000d2', 11, 500.00, 'khata');
INSERT INTO shopbook_invoice (id, shop_id, order_id, customer_user_id, number, total, source)
VALUES ('66666666-0000-4000-8000-0000000000d1', '22222222-0000-4000-8000-0000000000d1',
        '33333333-0000-4000-8000-0000000000d1',
        '11111111-0000-4000-8000-0000000000d2', 12, 630.00, 'order');

-- ── 4. one document per order, and per khata entry ────────────────
-- 069 enforced this with a table-level UNIQUE. 110 had to replace it with a
-- partial index to allow NULLs; this proves the replacement still bites.
DO $$
BEGIN
  BEGIN
    INSERT INTO shopbook_invoice (shop_id, order_id, customer_user_id, number, total, source)
    VALUES ('22222222-0000-4000-8000-0000000000d1', '33333333-0000-4000-8000-0000000000d1',
            '11111111-0000-4000-8000-0000000000d2', 13, 630.00, 'order');
    RAISE EXCEPTION 'second invoice issued for one order';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO shopbook_invoice (shop_id, ledger_id, customer_user_id, number, total, source)
    VALUES ('22222222-0000-4000-8000-0000000000d1', '77777777-0000-4000-8000-0000000000d1',
            '11111111-0000-4000-8000-0000000000d2', 14, 500.00, 'khata');
    RAISE EXCEPTION 'second invoice issued for one khata entry';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- but many counter sales, all with NULL order_id, must coexist
INSERT INTO shopbook_invoice (shop_id, number, total, source, walkin_name)
VALUES ('22222222-0000-4000-8000-0000000000d1', 15, 40.00, 'counter', 'Another walk-in');

-- ── 5. an issued document cannot be rewritten ─────────────────────
DO $$
DECLARE v NUMERIC;
BEGIN
  BEGIN
    UPDATE shopbook_invoice SET total = 1.00
     WHERE id='66666666-0000-4000-8000-0000000000d1';
    RAISE EXCEPTION 'issued invoice was UPDATEable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'issued invoice was UPDATEable' THEN RAISE; END IF;
  END;

  -- The snapshot columns matter as much as the money: rewriting the shop's
  -- address on an issued document forges history just as effectively.
  BEGIN
    UPDATE shopbook_invoice SET customer_name = 'Someone Else'
     WHERE id='66666666-0000-4000-8000-0000000000d1';
    RAISE EXCEPTION 'issued invoice customer was rewritable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'issued invoice customer was rewritable' THEN RAISE; END IF;
  END;

  SELECT total INTO v FROM shopbook_invoice WHERE id='66666666-0000-4000-8000-0000000000d1';
  IF v <> 630.00 THEN RAISE EXCEPTION 'invoice total mutated to %', v; END IF;
END $$;

-- ── 5b. …but it CAN still be cancelled or credited ────────────────
-- 094 defines these as the lifecycle states an actor chooses. A blanket UPDATE
-- ban would have quietly removed that capability while looking like safety.
DO $$
DECLARE st TEXT;
BEGIN
  UPDATE shopbook_invoice SET status='cancelled'
   WHERE id='66666666-0000-4000-8000-0000000000d1';

  SELECT status INTO st FROM shopbook_invoice WHERE id='66666666-0000-4000-8000-0000000000d1';
  IF st <> 'cancelled' THEN RAISE EXCEPTION 'status did not move (got %)', st; END IF;

  -- Cancelling must not become a back door for editing the numbers with it.
  BEGIN
    UPDATE shopbook_invoice SET status='credited', total=1.00
     WHERE id='66666666-0000-4000-8000-0000000000d1';
    RAISE EXCEPTION 'total changed alongside status';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'total changed alongside status' THEN RAISE; END IF;
  END;
END $$;

-- ── 6. …but the shop can still be deleted ─────────────────────────
-- The near-miss. shop_id and order_id are ON DELETE CASCADE, so a trigger that
-- also refused DELETE would have made every shop undeletable — and the failure
-- would have come from the invoice table while someone stared at the shop code.
DO $$
DECLARE n INT;
BEGIN
  DELETE FROM shopbook_shop WHERE id='22222222-0000-4000-8000-0000000000d1';

  SELECT COUNT(*) INTO n FROM shopbook_invoice
   WHERE shop_id='22222222-0000-4000-8000-0000000000d1';
  IF n <> 0 THEN RAISE EXCEPTION 'invoices survived shop delete (n=%)', n; END IF;

  SELECT COUNT(*) INTO n FROM shopbook_ledger_item
   WHERE ledger_id='77777777-0000-4000-8000-0000000000d1';
  IF n <> 0 THEN RAISE EXCEPTION 'ledger items survived shop delete (n=%)', n; END IF;
END $$;

-- ── 7. updated_at exists and did not fake its history ─────────────
-- Backfilled from created_at, not NOW(): rows written years ago must not claim
-- to have been edited the moment the migration ran.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM shopbook_ledger WHERE updated_at IS DISTINCT FROM created_at;
  IF n <> 0 THEN
    RAISE EXCEPTION 'pre-existing ledger rows had updated_at moved (n=%)', n;
  END IF;
END $$;

ROLLBACK;
