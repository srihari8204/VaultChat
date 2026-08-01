-- 062_shopbook_phase2.sql — SHOP BOOK Phase 2. Idempotent.
--
-- Adds: favorites, ratings & reviews, coupons/offers, supplier management,
-- loyalty points (derived from completed orders), and delivery + coupon
-- columns on existing tables. Still text-first — product photos are an
-- OPTIONAL key column only (no mandatory image pipeline in MVP).

-- ── favorites ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopbook_favorite (
  customer_user_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id          UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_user_id, shop_id)
);

-- ── ratings & reviews (one per order) ──────────────────────────────
CREATE TABLE IF NOT EXISTS shopbook_rating (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  customer_user_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id         UUID        UNIQUE REFERENCES shopbook_order(id) ON DELETE SET NULL,
  stars            INT         NOT NULL CHECK (stars BETWEEN 1 AND 5),
  review           TEXT        NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopbook_rating_shop ON shopbook_rating(shop_id, created_at DESC);

-- ── coupons / offers ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopbook_coupon (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  code       TEXT        NOT NULL,
  kind       TEXT        NOT NULL DEFAULT 'percent' CHECK (kind IN ('percent','flat')),
  value      NUMERIC(10,2) NOT NULL DEFAULT 0,   -- percent (0-100) or flat rupees
  min_order  NUMERIC(10,2) NOT NULL DEFAULT 0,
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, code)
);
CREATE INDEX IF NOT EXISTS idx_shopbook_coupon_shop ON shopbook_coupon(shop_id, active);

-- ── supplier / vendor management ───────────────────────────────────
CREATE TABLE IF NOT EXISTS shopbook_supplier (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  phone      TEXT        NOT NULL DEFAULT '',
  items      TEXT        NOT NULL DEFAULT '',   -- free-text list of supplied items
  note       TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopbook_supplier_shop ON shopbook_supplier(shop_id, name);

-- ── new columns on existing tables (idempotent) ────────────────────
ALTER TABLE shopbook_shop    ADD COLUMN IF NOT EXISTS delivery      BOOLEAN       NOT NULL DEFAULT FALSE;
ALTER TABLE shopbook_shop    ADD COLUMN IF NOT EXISTS delivery_fee  NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE shopbook_shop    ADD COLUMN IF NOT EXISTS rating_sum    INT           NOT NULL DEFAULT 0;
ALTER TABLE shopbook_shop    ADD COLUMN IF NOT EXISTS rating_count  INT           NOT NULL DEFAULT 0;

ALTER TABLE shopbook_product ADD COLUMN IF NOT EXISTS photo_key     TEXT          NOT NULL DEFAULT '';

ALTER TABLE shopbook_order   ADD COLUMN IF NOT EXISTS coupon_code   TEXT          NOT NULL DEFAULT '';
ALTER TABLE shopbook_order   ADD COLUMN IF NOT EXISTS discount      NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE shopbook_order   ADD COLUMN IF NOT EXISTS delivery      BOOLEAN       NOT NULL DEFAULT FALSE;
ALTER TABLE shopbook_order   ADD COLUMN IF NOT EXISTS delivery_fee  NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE shopbook_order   ADD COLUMN IF NOT EXISTS address       TEXT          NOT NULL DEFAULT '';
ALTER TABLE shopbook_order   ADD COLUMN IF NOT EXISTS points_earned INT           NOT NULL DEFAULT 0;
