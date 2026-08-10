-- 083_shopbook_not_collected.sql — SHOP BOOK collection handoff
-- (openspec: shop-book-upgrade, D5a). Idempotent.
--
-- Ready → Collected becomes the customer's transition (an owner cannot
-- truthfully assert a customer took the goods), so orders need an escape
-- hatch for goods that are never picked up: 'not_collected' is terminal and
-- — unlike 'completed' — posts no ledger purchase and issues no invoice.
-- Set by the owner after 24h in 'ready', or by the daily sweep after 7 days.

ALTER TABLE shopbook_order
  ADD COLUMN IF NOT EXISTS not_collected_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE shopbook_order DROP CONSTRAINT IF EXISTS shopbook_order_status_check;
ALTER TABLE shopbook_order ADD CONSTRAINT shopbook_order_status_check
  CHECK (status IN ('pending','accepted','preparing','packing','ready',
                    'collected','completed','rejected','cancelled','not_collected'));

-- The sweep and the 24h gate both date an order from its last 'ready' event.
CREATE INDEX IF NOT EXISTS idx_shopbook_order_ready
  ON shopbook_order(shop_id) WHERE status = 'ready';
