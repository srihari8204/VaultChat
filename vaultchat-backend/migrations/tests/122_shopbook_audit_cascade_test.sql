-- 122_shopbook_audit_cascade_test.sql — proves the audit log survives an
-- attacker and does not survive its own shop.
--
-- Four things, all of which only a database can answer:
--
--   1. a shop with audit rows can be deleted (the bug 122 closes)
--   2. the rows really did go with it
--   3. a direct DELETE against the log is still refused
--   4. UPDATE is still refused, at any depth
--
-- Run AFTER applying 122:
--
--   docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat \
--     -v ON_ERROR_STOP=1 -f - < this file
--
-- Self-cleaning: everything happens inside a transaction that is rolled back.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, phone, name) VALUES
 ('11111111-0000-4000-8000-0000000000a1', '+910000000a01', 'Audit Owner');

INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone, approved)
VALUES ('22222222-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1',
        'Audit Store', 'grocery', 'Pangidi', '+910000000a01', TRUE);

INSERT INTO shopbook_audit (shop_id, actor_user_id, action, entity, entity_id) VALUES
 ('22222222-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1',
  'price.change', 'product', 'p1'),
 ('22222222-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1',
  'ledger.entry', 'ledger', 'l1');

-- ── 1. the log cannot be edited ───────────────────────────────────
-- The original guarantee, unchanged by 122 and asserted first so a regression
-- here can never hide behind the new behaviour passing.
DO $chk1$
BEGIN
  BEGIN
    UPDATE shopbook_audit SET action = 'nothing.happened'
     WHERE shop_id = '22222222-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION 'AUDIT ROW WAS EDITABLE';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'AUDIT ROW WAS EDITABLE' THEN RAISE; END IF;
  END;
END $chk1$;

-- ── 2. the log cannot be deleted by hand ──────────────────────────
-- Deletion IS the attack on an audit trail: an actor who cannot rewrite a line
-- and can remove it has lost nothing.
DO $chk2$
BEGIN
  BEGIN
    DELETE FROM shopbook_audit WHERE shop_id = '22222222-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION 'AUDIT ROW WAS DIRECTLY DELETABLE';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'AUDIT ROW WAS DIRECTLY DELETABLE' THEN RAISE; END IF;
  END;
END $chk2$;

-- ── 3. the shop can be deleted (the bug) ──────────────────────────
-- Before 122 this raised, and a shop that had ever recorded one audited action
-- was permanently undeletable.
DELETE FROM shopbook_shop WHERE id = '22222222-0000-4000-8000-0000000000a1';

-- ── 4. and the rows went with it ──────────────────────────────────
-- A cascade that "succeeds" while leaving orphans behind would be a worse bug
-- than the one being fixed.
DO $chk4$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM shopbook_audit
   WHERE shop_id = '22222222-0000-4000-8000-0000000000a1';
  IF n <> 0 THEN RAISE EXCEPTION 'audit rows left after the shop went: %', n; END IF;
END $chk4$;

ROLLBACK;
