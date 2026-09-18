-- down/136_shopbook_money_minor.sql — reverse 136_shopbook_money_minor.sql.
--
-- Lives in this SUBDIRECTORY and not beside 136 on purpose:
-- scripts/check-migration-drift.js takes the numeric prefix of every *.sql in
-- migrations/ as a version, so a "136_..._down.sql" sitting next to it would be
-- reported as duplicate version 136 and the drift check would start failing.
-- Nothing in the repo had a down migration before this one (135 is the example
-- of what not to copy: CREATE OR REPLACE with no way back), so the convention
-- is set here rather than inherited.
--
-- Run: psql -f migrations/down/137_... then this one. Never against production.
--
-- Lossless AS LONG AS the application is still writing the NUMERIC columns —
-- which, at this stage, it is: 136+137 are read-compatible only, the decimal
-- columns remain authoritative, and the minor columns are a parallel copy.
-- After a later cutover makes the minor columns authoritative this stops being
-- lossless for 3dp currencies, because NUMERIC(_,2) cannot hold their third
-- decimal. That cutover must therefore carry its own, different down. Said
-- plainly here rather than discovered then.

BEGIN;

ALTER TABLE shopbook_shop        DROP COLUMN IF EXISTS delivery_fee_minor;

ALTER TABLE shopbook_product     DROP COLUMN IF EXISTS price_minor,
                                 DROP COLUMN IF EXISTS cost_price_minor,
                                 DROP COLUMN IF EXISTS avg_cost_minor;

ALTER TABLE shopbook_order       DROP COLUMN IF EXISTS subtotal_minor,
                                 DROP COLUMN IF EXISTS discount_minor,
                                 DROP COLUMN IF EXISTS bill_discount_minor,
                                 DROP COLUMN IF EXISTS tax_total_minor,
                                 DROP COLUMN IF EXISTS delivery_fee_minor,
                                 DROP COLUMN IF EXISTS round_off_minor,
                                 DROP COLUMN IF EXISTS total_minor;

ALTER TABLE shopbook_order_item  DROP COLUMN IF EXISTS price_minor,
                                 DROP COLUMN IF EXISTS alt_price_minor,
                                 DROP COLUMN IF EXISTS line_discount_minor,
                                 DROP COLUMN IF EXISTS line_tax_minor,
                                 DROP COLUMN IF EXISTS line_total_minor,
                                 DROP COLUMN IF EXISTS cost_at_sale_minor;

ALTER TABLE shopbook_invoice     DROP COLUMN IF EXISTS subtotal_minor,
                                 DROP COLUMN IF EXISTS discount_minor,
                                 DROP COLUMN IF EXISTS tax_total_minor,
                                 DROP COLUMN IF EXISTS total_minor;

ALTER TABLE shopbook_payment     DROP COLUMN IF EXISTS amount_minor;
ALTER TABLE shopbook_customer    DROP COLUMN IF EXISTS credit_limit_minor;
ALTER TABLE shopbook_coupon      DROP COLUMN IF EXISTS value_minor,
                                 DROP COLUMN IF EXISTS min_order_minor;

DELETE FROM schema_migrations WHERE version::int = 136;

COMMIT;
