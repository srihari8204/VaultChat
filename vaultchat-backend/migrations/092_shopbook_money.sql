-- 092_shopbook_money.sql — SHOP BOOK financial foundation (P0-A). Idempotent.
--
-- Three things the order rows could not previously express, and one they
-- expressed wrongly:
--
--   1. WHICH catalog row a line came from. Without product_id the server had
--      no way to re-derive a price, so it took the client's. Anyone could
--      order at price 0.
--   2. The finalized money breakdown. `total` alone could not answer "what was
--      the tax?", so the invoice recomputed it — and arrived at a different
--      number than the ledger, which posted the tax-exclusive `total`.
--      subtotal/discount/tax_total/round_off/total now live on the order and
--      every downstream record (invoice, ledger, reports) copies them.
--   3. The tax rules in force at pricing time. tax_snapshot freezes them, so a
--      later admin edit to shopbook_country cannot restate a historical order.
--   4. Idempotency. A retried POST created a second order or a second payment.
--
-- Money stays NUMERIC — exact in Postgres. Go reads it as integer minor units
-- ((col*100)::bigint) and writes it back as ($n::numeric/100), so no float ever
-- touches a monetary value on the way through.

-- ── order: the finalized financial snapshot ────────────────────────
ALTER TABLE shopbook_order
  ADD COLUMN IF NOT EXISTS subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_total       NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_off       NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_snapshot    JSONB         NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT          NOT NULL DEFAULT '';

-- A retry carries the same key: the second insert loses, and the handler
-- returns the order the first one created. Scoped per customer so two
-- customers can never collide on a guessed key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_order_idem
  ON shopbook_order(customer_user_id, idempotency_key)
  WHERE idempotency_key <> '';

-- Backfill: pre-092 orders carried a tax-exclusive total and no breakdown.
-- Their subtotal is the sum of the lines that were actually going to be
-- supplied; tax_total stays 0 because no tax was ever charged on them.
UPDATE shopbook_order o
   SET subtotal = COALESCE((
         SELECT SUM(i.price * i.qty) FROM shopbook_order_item i
          WHERE i.order_id = o.id AND i.availability <> 'unavailable'), 0)
 WHERE o.subtotal = 0;

-- ── order items: catalog provenance + per-line money ───────────────
ALTER TABLE shopbook_order_item
  ADD COLUMN IF NOT EXISTS product_id    UUID REFERENCES shopbook_product(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS custom        BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS line_discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS line_tax      NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS line_total    NUMERIC(12,2) NOT NULL DEFAULT 0;

UPDATE shopbook_order_item
   SET line_total = price * qty
 WHERE line_total = 0 AND price > 0;

-- ── ledger: idempotent money entries ───────────────────────────────
ALTER TABLE shopbook_ledger
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_ledger_idem
  ON shopbook_ledger(shop_id, idempotency_key)
  WHERE idempotency_key <> '';

-- Settlement writes exactly one purchase row per order; the guard was a
-- SELECT-then-INSERT, which two concurrent collects could both pass.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_ledger_order_purchase
  ON shopbook_ledger(order_id) WHERE type = 'purchase' AND order_id IS NOT NULL;

-- A negative amount would invert a purchase into a credit with no record of
-- why. Corrections get their own entry (and, from P1-B, a credit note).
ALTER TABLE shopbook_ledger DROP CONSTRAINT IF EXISTS shopbook_ledger_amount_positive;
ALTER TABLE shopbook_ledger ADD CONSTRAINT shopbook_ledger_amount_positive
  CHECK (amount >= 0);
