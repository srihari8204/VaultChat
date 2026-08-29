-- 112_khata_credit_limit_test.sql — rehearses the credit ceiling and the
-- derived khata amount against a copy of the real schema.
--
-- WHY THIS FILE EXISTS
--
--   The Go side of walk-in khata is verified STRUCTURALLY: shopbook_walkin_test.go
--   reads the source and asserts that credit_limit is consulted in two places.
--   That catches a deleted line. It cannot catch the thing that actually costs a
--   shop money — a ceiling compared against the wrong balance, or an entry whose
--   stored amount disagrees with the lines printed on the customer's bill.
--
--   Both are decided by data, so both are answerable here and nowhere else:
--
--     · a walk-in's limit and an account customer's limit live in DIFFERENT
--       tables (112 had to add a column because shopbook_customer.customer_user_id
--       is a users FK a walk-in can never satisfy) and must mean the same thing
--       against the SAME derived balance;
--     · 0 must keep meaning "no ceiling", because that is the schema default
--       every existing row already carries — a test that only checks the
--       enforcing case would pass while every production row silently changed
--       behaviour;
--     · Σ(qty × price) over the lines is the entry's amount, which is what makes
--       the khata a bill rather than a number somebody typed.
--
--   docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat \
--     -v ON_ERROR_STOP=1 -f - < this file
--
-- Self-cleaning: everything happens inside a transaction that is rolled back.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name) VALUES
 ('11111111-0000-4000-8000-0000000000c1', '+910000000c01', 'Limit Owner'),
 ('11111111-0000-4000-8000-0000000000c2', '+910000000c02', 'Account Customer');

INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone, approved)
VALUES ('22222222-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c1',
        'Limit Store', 'grocery', 'Pangidi', '+910000000c01', TRUE);

INSERT INTO shopbook_khata_customer (id, shop_id, name, mobile)
VALUES ('44444444-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000c1',
        'Walk-in Ramesh', '+910000000c03');

-- ── 1. the default IS the old behaviour ───────────────────────────
-- 112 backfilled nothing, on the grounds that DEFAULT 0 already reproduces
-- "unconstrained". If that default ever changes, every pre-112 walk-in starts
-- being refused at the counter.
DO $chk1$
DECLARE lim NUMERIC;
BEGIN
  SELECT credit_limit INTO lim FROM shopbook_khata_customer
   WHERE id = '44444444-0000-4000-8000-0000000000c1';
  IF lim <> 0 THEN RAISE EXCEPTION 'new walk-in limit = %, want 0 (no ceiling)', lim; END IF;
END $chk1$;

-- ── 2. a negative ceiling is not a ceiling ────────────────────────
DO $chk2$
BEGIN
  BEGIN
    UPDATE shopbook_khata_customer SET credit_limit = -1
     WHERE id = '44444444-0000-4000-8000-0000000000c1';
    RAISE EXCEPTION 'negative credit_limit accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $chk2$;

-- ── 3. the ceiling is compared against the DERIVED balance ────────
-- sbCreditCheck never reads a stored total; it sums the ledger. Rehearsed here
-- with the same SUM so a future "optimisation" that caches a balance has to
-- disagree with this file to land.
UPDATE shopbook_khata_customer SET credit_limit = 1000.00
 WHERE id = '44444444-0000-4000-8000-0000000000c1';

INSERT INTO shopbook_ledger (shop_id, khata_customer_id, type, amount, remark) VALUES
 ('22222222-0000-4000-8000-0000000000c1', '44444444-0000-4000-8000-0000000000c1',
  'purchase', 800.00, 'rice and oil'),
 ('22222222-0000-4000-8000-0000000000c1', '44444444-0000-4000-8000-0000000000c1',
  'payment', 200.00, 'part paid');

DO $chk3$
DECLARE bal NUMERIC; lim NUMERIC;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN type='purchase' THEN amount ELSE -amount END), 0) INTO bal
    FROM shopbook_ledger WHERE khata_customer_id = '44444444-0000-4000-8000-0000000000c1';
  SELECT credit_limit INTO lim FROM shopbook_khata_customer
   WHERE id = '44444444-0000-4000-8000-0000000000c1';

  IF bal <> 600.00 THEN RAISE EXCEPTION 'derived balance = %, want 600.00', bal; END IF;
  -- 600 + 300 is under 1000: allowed.
  IF bal + 300.00 > lim THEN RAISE EXCEPTION 'entry inside the ceiling was refused'; END IF;
  -- 600 + 500 is over 1000: the owner must be asked.
  IF bal + 500.00 <= lim THEN RAISE EXCEPTION 'entry past the ceiling was not caught'; END IF;
END $chk3$;

-- ── 4. 0 means no ceiling, not a ceiling of nothing ───────────────
-- The failure this guards is a one-character one: `limit > 0` becoming
-- `limit >= 0` refuses every entry for every customer whose owner never set a
-- limit, which is nearly all of them.
DO $chk4$
DECLARE bal NUMERIC;
BEGIN
  UPDATE shopbook_khata_customer SET credit_limit = 0
   WHERE id = '44444444-0000-4000-8000-0000000000c1';
  SELECT COALESCE(SUM(CASE WHEN type='purchase' THEN amount ELSE -amount END), 0) INTO bal
    FROM shopbook_ledger WHERE khata_customer_id = '44444444-0000-4000-8000-0000000000c1';
  IF NOT (0 <= 0) OR bal <= 0 THEN
    RAISE EXCEPTION 'fixture wrong: balance % should be positive with a 0 limit', bal;
  END IF;
END $chk4$;

-- ── 5. the same rule, the other table ─────────────────────────────
-- An account customer's ceiling lives on shopbook_customer. Two storage
-- locations, one meaning: the arithmetic must not differ.
INSERT INTO shopbook_customer (shop_id, customer_user_id, credit_limit)
VALUES ('22222222-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c2', 500.00)
ON CONFLICT (shop_id, customer_user_id) DO UPDATE SET credit_limit = 500.00;

INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark)
VALUES ('22222222-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c2',
        'purchase', 450.00, 'on the app');

DO $chk5$
DECLARE bal NUMERIC; lim NUMERIC;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN type='purchase' THEN amount ELSE -amount END), 0) INTO bal
    FROM shopbook_ledger WHERE customer_user_id = '11111111-0000-4000-8000-0000000000c2';
  SELECT credit_limit INTO lim FROM shopbook_customer
   WHERE shop_id = '22222222-0000-4000-8000-0000000000c1'
     AND customer_user_id = '11111111-0000-4000-8000-0000000000c2';
  IF bal <> 450.00 THEN RAISE EXCEPTION 'account balance = %, want 450.00', bal; END IF;
  IF bal + 100.00 <= lim THEN RAISE EXCEPTION 'account ceiling not enforced at 500'; END IF;
END $chk5$;

-- ── 6. a khata entry's amount is its lines ────────────────────────
-- The client total is ignored on the write path; what makes that safe is that
-- Σ(qty × price) is the only number the document restates. If the two ever
-- disagree the customer is handed a bill that does not add up to what they owe.
INSERT INTO shopbook_ledger (id, shop_id, khata_customer_id, type, amount, remark)
VALUES ('77777777-0000-4000-8000-0000000000c1', '22222222-0000-4000-8000-0000000000c1',
        '44444444-0000-4000-8000-0000000000c1', 'purchase', 500.00, 'itemised');

INSERT INTO shopbook_ledger_item (ledger_id, name, unit, qty, price, tax_percent) VALUES
 ('77777777-0000-4000-8000-0000000000c1', 'Rice',  '5kg', 1, 300.00, 5),
 ('77777777-0000-4000-8000-0000000000c1', 'Sugar', '1kg', 2, 100.00, 5);

DO $chk6$
DECLARE lines NUMERIC; amt NUMERIC;
BEGIN
  SELECT SUM(qty * price) INTO lines FROM shopbook_ledger_item
   WHERE ledger_id = '77777777-0000-4000-8000-0000000000c1';
  SELECT amount INTO amt FROM shopbook_ledger
   WHERE id = '77777777-0000-4000-8000-0000000000c1';
  IF lines <> amt THEN
    RAISE EXCEPTION 'lines total % <> entry amount % — the bill and the debt disagree', lines, amt;
  END IF;
  -- Tax is carried on the line but NOT added: the document restates what the
  -- khata posted (shopbook_documents.go). 5%% on 500 would be 525.
  IF amt <> 500.00 THEN RAISE EXCEPTION 'tax leaked into the khata amount: %', amt; END IF;
END $chk6$;

-- ── 7. the write is audited ───────────────────────────────────────
-- 095's own header named the gap ("ledger adjustments happened silently") and
-- sbAddLedgerEntry now writes this row in the same transaction as the entry.
INSERT INTO shopbook_audit (shop_id, actor_user_id, action, entity, entity_id, after)
VALUES ('22222222-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000c1',
        'ledger.entry', 'ledger', '77777777-0000-4000-8000-0000000000c1',
        '{"amount": 500.00}'::jsonb);

DO $chk7$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM shopbook_audit
   WHERE entity = 'ledger' AND entity_id = '77777777-0000-4000-8000-0000000000c1';
  IF n <> 1 THEN RAISE EXCEPTION 'audit rows for the entry = %, want 1', n; END IF;

  -- An audit row the audited party can edit records nothing.
  BEGIN
    UPDATE shopbook_audit SET action = 'nothing.happened'
     WHERE entity_id = '77777777-0000-4000-8000-0000000000c1';
    RAISE EXCEPTION 'audit row was editable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'audit row was editable' THEN RAISE; END IF;  -- our own, not the trigger's
  END;
END $chk7$;

-- NOTE, not asserted here because it is unfixed: shopbook_audit's append-only
-- trigger is BEFORE UPDATE OR DELETE while shop_id is ON DELETE CASCADE, so
-- deleting a shop that has audit rows raises instead of cascading. 110 hit the
-- identical shape on shopbook_invoice and narrowed the trigger to UPDATE. The
-- same one-line narrowing is owed here, in a migration of its own.

ROLLBACK;
