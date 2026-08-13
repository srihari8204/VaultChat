-- 093_shopbook_inventory.sql — SHOP BOOK real inventory (P0-B). Idempotent.
--
-- Until now "stock" was one boolean per product, set by hand. Two customers
-- could each order the last two bags of rice and both be accepted, because
-- nothing anywhere counted. This adds the count, and — more importantly — the
-- RESERVATION, which is the only part that actually prevents overselling.
--
-- Three pieces:
--
--   shopbook_stock           per product: on_hand, reserved. available is
--                            GENERATED, so no code path can compute it wrong.
--   shopbook_stock_movement  every change, immutable, with actor and reason.
--                            on_hand is Σ(on_hand_delta) — the table is a
--                            ledger, and shopbook_stock is its running total.
--   product.track_stock      opt-in per product. A vegetable shop selling by
--                            the handful should not be forced to count, and
--                            inventory is a Pro feature (spec:
--                            subscription-plans), so untracked products behave
--                            EXACTLY as before: the in_stock boolean.
--
-- Quantities are NUMERIC(12,2) to match shopbook_order_item.qty exactly — a
-- reservation that cannot express the quantity it is reserving is not a
-- reservation. Go carries them as integer hundredths, like money.

-- ── per-product stock position ────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopbook_stock (
  product_id    UUID PRIMARY KEY REFERENCES shopbook_product(id) ON DELETE CASCADE,
  shop_id       UUID          NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  on_hand       NUMERIC(12,2) NOT NULL DEFAULT 0,
  reserved      NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- available is derived, never stored independently: the single most common
  -- inventory bug is two columns that disagree about the same fact.
  available     NUMERIC(12,2) GENERATED ALWAYS AS (on_hand - reserved) STORED,
  reorder_level NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- Reserved stock that exceeds what is on the shelf means a reservation was
  -- granted twice. Fail the transaction rather than discover it in a report.
  CONSTRAINT shopbook_stock_sane CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)
);
CREATE INDEX IF NOT EXISTS idx_shopbook_stock_shop ON shopbook_stock(shop_id);
-- Low-stock sweeps ask one question: what is at or under its reorder level?
CREATE INDEX IF NOT EXISTS idx_shopbook_stock_low
  ON shopbook_stock(shop_id) WHERE reorder_level > 0;

-- ── the movement ledger ───────────────────────────────────────────
-- No UPDATE, no DELETE: a correction is another movement. `kind` is open to
-- new values by design (transfer, write-off, cycle count) — the CHECK is a
-- typo guard, not a schema decision to relitigate later.
CREATE TABLE IF NOT EXISTS shopbook_stock_movement (
  id             BIGSERIAL PRIMARY KEY,
  shop_id        UUID          NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  product_id     UUID          NOT NULL REFERENCES shopbook_product(id) ON DELETE CASCADE,
  kind           TEXT          NOT NULL
                   CHECK (kind IN ('opening','purchase','sale','reservation',
                                   'reservation_release','damage','adjustment',
                                   'return','transfer')),
  -- Signed deltas. A sale moves BOTH (goods leave, and the reservation that
  -- held them is consumed); a reservation moves only `reserved`.
  on_hand_delta  NUMERIC(12,2) NOT NULL DEFAULT 0,
  reserved_delta NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit           TEXT          NOT NULL DEFAULT '',
  reason         TEXT          NOT NULL DEFAULT '',
  actor_user_id  UUID          REFERENCES users(id) ON DELETE SET NULL,
  -- What caused it: ('order', <id>), ('purchase', <id>), ('adjustment','').
  ref_entity     TEXT          NOT NULL DEFAULT '',
  ref_id         TEXT          NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopbook_movement_product
  ON shopbook_stock_movement(product_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_shopbook_movement_shop
  ON shopbook_stock_movement(shop_id, created_at DESC);
-- Reserve-once / release-once per order line. Without this a retried accept
-- reserves the same goods twice and the shop oversells itself.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_movement_once
  ON shopbook_stock_movement(ref_entity, ref_id, product_id, kind)
  WHERE ref_entity <> '' AND kind IN ('reservation','reservation_release','sale');

-- ── product: opt into counting ────────────────────────────────────
ALTER TABLE shopbook_product
  ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT FALSE,
  -- Cost is what makes a margin computable (P1-A builds purchases on it).
  ADD COLUMN IF NOT EXISTS cost_price  NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Every tracked product needs a stock row; create it lazily in code, but keep
-- the invariant reachable here for products that already exist.
INSERT INTO shopbook_stock (product_id, shop_id)
SELECT p.id, p.shop_id FROM shopbook_product p
 WHERE p.track_stock AND NOT EXISTS (SELECT 1 FROM shopbook_stock s WHERE s.product_id = p.id);
