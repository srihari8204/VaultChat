-- 070_shopbook_collected_by.sql — SHOP BOOK: who confirmed collection.
-- (openspec: customer-collection-and-receipt). Idempotent.
--
-- Collection can now be confirmed by the customer at the counter as well as by
-- the shop owner. Both paths settle identically (khata purchase + invoice), so
-- the order records WHICH party confirmed it — mirroring the existing
-- cancelled_by convention.
--
-- Additive with a default: the running binary ignores it, and orders collected
-- before this migration simply carry '' (unknown).

ALTER TABLE shopbook_order ADD COLUMN IF NOT EXISTS collected_by TEXT NOT NULL DEFAULT ''
  CHECK (collected_by IN ('', 'customer', 'owner'));
