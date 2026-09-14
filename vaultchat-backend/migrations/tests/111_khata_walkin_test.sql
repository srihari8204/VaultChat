-- 111_khata_walkin_test.sql — rehearses the walk-in khata against a copy of the
-- real schema.
--
-- What only the database can answer: whether a khata line can exist for someone
-- with no VaultChat account, whether a line can point at BOTH parties or
-- NEITHER, whether the shop's receivable survives the customer deleting their
-- account (061's CASCADE is exactly the mistake this must not repeat), whether
-- a contact carrying a balance can be deleted out from under it, and whether
-- the derived balance still adds up when a shop has both kinds of customer.
--
-- Section 8 is the REGRESSION check: the account-holder khata that has worked
-- since 061 must behave identically after this migration.
--
--   docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat \
--     -v ON_ERROR_STOP=1 -f - < this file
--
-- Self-cleaning: everything happens inside a transaction that is rolled back.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name) VALUES
 ('11111111-0000-4000-8000-00000000e001', '+910000000e01', 'Khata Owner'),
 ('11111111-0000-4000-8000-00000000e002', '+910000000e02', 'App Customer'),
 ('11111111-0000-4000-8000-00000000e003', '+910000000e03', 'Leaver');

INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone, approved)
VALUES ('22222222-0000-4000-8000-00000000e001', '11111111-0000-4000-8000-00000000e001',
        'Khata Store', 'grocery', 'Pangidi', '+910000000e01', TRUE);

-- Ramesh has no VaultChat account. This is the case 061 could not express.
INSERT INTO shopbook_khata_customer (id, shop_id, name, mobile, device_id, local_id)
VALUES ('44444444-0000-4000-8000-00000000e001', '22222222-0000-4000-8000-00000000e001',
        'Ramesh', '+919000000001', 'devA', 'local-001');

-- ---- 1. a walk-in can carry a khata -------------------------------
INSERT INTO shopbook_ledger (id, shop_id, khata_customer_id, type, amount, remark, idempotency_key)
VALUES ('55555555-0000-4000-8000-00000000e001', '22222222-0000-4000-8000-00000000e001',
        '44444444-0000-4000-8000-00000000e001', 'purchase', 1300.00, 'Rice 5kg x2', 'devA:txn-001');

DO $chk1$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM shopbook_ledger
   WHERE khata_customer_id = '44444444-0000-4000-8000-00000000e001';
  IF n <> 1 THEN RAISE EXCEPTION 'walk-in khata line not stored (got %)', n; END IF;
END $chk1$;

-- ---- 2. a line must name exactly ONE party ------------------------
DO $chk2$
BEGIN
  BEGIN
    INSERT INTO shopbook_ledger (shop_id, type, amount, remark)
    VALUES ('22222222-0000-4000-8000-00000000e001', 'purchase', 10.00, 'nobody');
    RAISE EXCEPTION 'a ledger line with NO party was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO shopbook_ledger (shop_id, customer_user_id, khata_customer_id, type, amount, remark)
    VALUES ('22222222-0000-4000-8000-00000000e001', '11111111-0000-4000-8000-00000000e002',
            '44444444-0000-4000-8000-00000000e001', 'purchase', 10.00, 'both');
    RAISE EXCEPTION 'a ledger line with BOTH parties was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $chk2$;

-- ---- 3. the shop's receivable survives an account deletion --------
-- 061 attached ON DELETE CASCADE to customer_user_id, so a customer deleting
-- their account erases the shop's money. linked_user_id must NOT repeat that.
INSERT INTO shopbook_khata_customer (id, shop_id, name, mobile, linked_user_id)
VALUES ('44444444-0000-4000-8000-00000000e002', '22222222-0000-4000-8000-00000000e001',
        'Also On App', '+919000000002', '11111111-0000-4000-8000-00000000e003');

INSERT INTO shopbook_ledger (shop_id, khata_customer_id, type, amount, remark)
VALUES ('22222222-0000-4000-8000-00000000e001', '44444444-0000-4000-8000-00000000e002',
        'purchase', 700.00, 'owed before they left');

DELETE FROM users WHERE id = '11111111-0000-4000-8000-00000000e003';

DO $chk3$
DECLARE n INT; link UUID;
BEGIN
  SELECT count(*) INTO n FROM shopbook_ledger
   WHERE khata_customer_id = '44444444-0000-4000-8000-00000000e002';
  IF n <> 1 THEN RAISE EXCEPTION 'account deletion destroyed the shop receivable (got % lines)', n; END IF;
  SELECT linked_user_id INTO link FROM shopbook_khata_customer
   WHERE id = '44444444-0000-4000-8000-00000000e002';
  IF link IS NOT NULL THEN RAISE EXCEPTION 'linked_user_id was not cleared on delete'; END IF;
END $chk3$;

-- ---- 4. a contact carrying history cannot vanish ------------------
DO $chk4$
BEGIN
  BEGIN
    DELETE FROM shopbook_khata_customer WHERE id = '44444444-0000-4000-8000-00000000e001';
    RAISE EXCEPTION 'a khata contact with ledger history was deleted (RESTRICT not enforced)';
  -- ON DELETE RESTRICT raises restrict_violation (23001), NOT
  -- foreign_key_violation (23503) — 23503 is what NO ACTION raises. The FK at
  -- 111_shopbook_khata_walkin.sql:75 is RESTRICT, so catching only 23503 let
  -- the very error this section is proving escape and abort the file. Found
  -- the first time these tests were actually executed. Both are listed
  -- because the assertion is "the delete must fail", not "it must fail with
  -- one particular sqlstate" — and RAISE EXCEPTION above is P0001, so a
  -- delete that SUCCEEDS is still uncaught and still fails the run.
  EXCEPTION WHEN restrict_violation OR foreign_key_violation THEN NULL; END;
END $chk4$;

-- ---- 5. duplicate protection --------------------------------------
DO $chk5$
BEGIN
  BEGIN
    INSERT INTO shopbook_khata_customer (shop_id, name, mobile)
    VALUES ('22222222-0000-4000-8000-00000000e001', 'Ramesh Again', '+919000000001');
    RAISE EXCEPTION 'two khata contacts share one mobile at one shop';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- A retried sync of the SAME locally-created customer must not fork.
  BEGIN
    INSERT INTO shopbook_khata_customer (shop_id, name, mobile, device_id, local_id)
    VALUES ('22222222-0000-4000-8000-00000000e001', 'Ramesh Retry', '', 'devA', 'local-001');
    RAISE EXCEPTION 'a replayed offline customer created a second contact';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $chk5$;

-- A name-only khata is legitimate — mobile is optional, so the partial index
-- must permit many blanks.
INSERT INTO shopbook_khata_customer (shop_id, name) VALUES
 ('22222222-0000-4000-8000-00000000e001', 'The man with the cycle'),
 ('22222222-0000-4000-8000-00000000e001', 'Auto driver');

-- ---- 6. the replayed transaction is still one transaction ---------
-- 092's partial unique index on (shop_id, idempotency_key) is what the offline
-- sync layer relies on. It must hold for walk-in lines too.
DO $chk6$
BEGIN
  BEGIN
    INSERT INTO shopbook_ledger (shop_id, khata_customer_id, type, amount, remark, idempotency_key)
    VALUES ('22222222-0000-4000-8000-00000000e001', '44444444-0000-4000-8000-00000000e001',
            'purchase', 1300.00, 'Rice 5kg x2', 'devA:txn-001');
    RAISE EXCEPTION 'a replayed offline transaction created a duplicate ledger line';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $chk6$;

-- ---- 7. the balance is derived, and it adds up --------------------
-- Purchase 1300 + purchase 400 - payment 500 = 1200, computed the same way
-- shopbook.go does it. Two devices appending independently is exactly this.
INSERT INTO shopbook_ledger (shop_id, khata_customer_id, type, amount, remark, idempotency_key) VALUES
 ('22222222-0000-4000-8000-00000000e001', '44444444-0000-4000-8000-00000000e001',
  'purchase', 400.00, 'Dal 1kg', 'devA:txn-002'),
 ('22222222-0000-4000-8000-00000000e001', '44444444-0000-4000-8000-00000000e001',
  'payment', 500.00, 'part payment', 'devB:txn-001');

DO $chk7$
DECLARE bal NUMERIC;
BEGIN
  SELECT SUM(CASE WHEN type = 'purchase' THEN amount ELSE -amount END) INTO bal
    FROM shopbook_ledger WHERE khata_customer_id = '44444444-0000-4000-8000-00000000e001';
  IF bal <> 1200.00 THEN RAISE EXCEPTION 'derived balance = %, want 1200.00', bal; END IF;
END $chk7$;

-- ---- 8. REGRESSION: the account-holder khata is untouched ---------
-- Everything 061 could already do must still work, unchanged.
INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark) VALUES
 ('22222222-0000-4000-8000-00000000e001', '11111111-0000-4000-8000-00000000e002',
  'purchase', 250.00, 'on the app'),
 ('22222222-0000-4000-8000-00000000e001', '11111111-0000-4000-8000-00000000e002',
  'payment', 100.00, 'settled some');

DO $chk8$
DECLARE bal NUMERIC; n INT;
BEGIN
  SELECT SUM(CASE WHEN type = 'purchase' THEN amount ELSE -amount END) INTO bal
    FROM shopbook_ledger WHERE customer_user_id = '11111111-0000-4000-8000-00000000e002';
  IF bal <> 150.00 THEN RAISE EXCEPTION 'app-customer balance = %, want 150.00', bal; END IF;

  -- The two kinds of customer must not leak into each other's ledger.
  SELECT count(*) INTO n FROM shopbook_ledger
   WHERE customer_user_id = '11111111-0000-4000-8000-00000000e002'
     AND khata_customer_id IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'party columns are not mutually exclusive in practice'; END IF;
END $chk8$;

ROLLBACK;
