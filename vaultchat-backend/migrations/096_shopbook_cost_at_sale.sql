-- 096_shopbook_cost_at_sale.sql — freeze cost of goods at the moment of sale.
-- Idempotent.
--
-- 095 computed gross profit from shopbook_product.avg_cost as it stands NOW.
-- That means a delivery arriving today silently restates last week's profit —
-- the same defect the invoice had before 092, where a later config edit could
-- rewrite a finished document.
--
-- A sale's cost is a fact about the day it happened. It is stamped onto the
-- line when the goods leave the shelf (sbConsumeOrder) and never recomputed.
--
-- NULL means "no cost basis" — a product bought before purchases were
-- recorded. Reports must exclude those lines rather than treat them as zero
-- cost, which would report the entire sale price as profit.
ALTER TABLE shopbook_order_item
  ADD COLUMN IF NOT EXISTS cost_at_sale NUMERIC(12,2);

-- Reporting reads this per shop over a date range, via the order.
CREATE INDEX IF NOT EXISTS idx_shopbook_order_item_cost
  ON shopbook_order_item(order_id) WHERE cost_at_sale IS NOT NULL;
