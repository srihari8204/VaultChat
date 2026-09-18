-- down/137_shopbook_money_minor_backfill.sql — reverse the backfill.
--
-- Fully reversible, and this is the reason 137 is a separate migration from
-- 136: it touched no schema and no decimal column, so undoing it is setting the
-- parallel copy back to NULL. NULL is what the read path already treats as
-- "not backfilled — read the decimal column" (readMoney() in
-- utils/currencyMinor.ts), so a row reverted by this file reads exactly as it
-- did before 137 ran, to the paisa.
--
-- Deliberately NOT conditional on how the value got there. Anything written
-- into a *_minor column while this stage is live is a copy of the decimal
-- column, never the only record of an amount. If that ever stops being true,
-- this file stops being a valid down and the cutover that changed it owes a
-- different one.
--
-- Never against production.

BEGIN;

UPDATE shopbook_shop       SET delivery_fee_minor = NULL;
UPDATE shopbook_product    SET price_minor = NULL, cost_price_minor = NULL, avg_cost_minor = NULL;
UPDATE shopbook_order      SET subtotal_minor = NULL, discount_minor = NULL,
                               bill_discount_minor = NULL, tax_total_minor = NULL,
                               delivery_fee_minor = NULL, round_off_minor = NULL,
                               total_minor = NULL;
UPDATE shopbook_order_item SET price_minor = NULL, alt_price_minor = NULL,
                               line_discount_minor = NULL, line_tax_minor = NULL,
                               line_total_minor = NULL, cost_at_sale_minor = NULL;
UPDATE shopbook_invoice    SET subtotal_minor = NULL, discount_minor = NULL,
                               tax_total_minor = NULL, total_minor = NULL;
UPDATE shopbook_payment    SET amount_minor = NULL;
UPDATE shopbook_customer   SET credit_limit_minor = NULL;
UPDATE shopbook_coupon     SET value_minor = NULL, min_order_minor = NULL;

DROP FUNCTION IF EXISTS sb_minor_exponent(TEXT);

DELETE FROM schema_migrations WHERE version::int = 137;

COMMIT;
