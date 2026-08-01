-- 061_shopbook.sql — SHOP BOOK mini-app. Idempotent.
--
-- A lightweight two-sided local-commerce layer riding on the same Postgres.
-- Text-only catalog (no product images in MVP). Five content-light tables:
--   shopbook_shop         one row per shop (owned by a VaultChat user)
--   shopbook_product      text catalog rows for a shop
--   shopbook_order        one customer order against a shop
--   shopbook_order_item   line items (incl. free-typed custom products)
--   shopbook_ledger       digital khata: purchase / payment entries.
--                         Pending balance is DERIVED (Σpurchase − Σpayment).
--
-- No RLS on these tables — routes scope every query by owner/customer id
-- explicitly, matching the Node-era access pattern for content-light features.

CREATE TABLE IF NOT EXISTS shopbook_shop (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  category       TEXT        NOT NULL DEFAULT 'grocery',
  address        TEXT        NOT NULL DEFAULT '',
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  phone          TEXT        NOT NULL DEFAULT '',
  open_time      TEXT        NOT NULL DEFAULT '09:00',   -- HH:MM
  close_time     TEXT        NOT NULL DEFAULT '21:00',   -- HH:MM
  weekly_holiday TEXT        NOT NULL DEFAULT '',        -- e.g. 'sun'
  status         TEXT        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','busy','closed')),
  pickup         BOOLEAN     NOT NULL DEFAULT TRUE,
  prep_mins      INT         NOT NULL DEFAULT 20,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One shop per owner in the free tier; the app enforces the count, but the
-- unique index keeps the "primary shop" lookup by owner cheap.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_shop_owner ON shopbook_shop(owner_user_id);
-- Nearby search is a bounding-box scan on (lat,lng).
CREATE INDEX IF NOT EXISTS idx_shopbook_shop_geo ON shopbook_shop(lat, lng);

CREATE TABLE IF NOT EXISTS shopbook_product (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  brand      TEXT        NOT NULL DEFAULT '',
  category   TEXT        NOT NULL DEFAULT '',
  unit       TEXT        NOT NULL DEFAULT '',           -- e.g. '1kg', '1L'
  price      NUMERIC(10,2) NOT NULL DEFAULT 0,
  in_stock   BOOLEAN     NOT NULL DEFAULT TRUE,
  enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopbook_product_shop ON shopbook_product(shop_id, enabled);

CREATE TABLE IF NOT EXISTS shopbook_order (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  customer_user_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT        NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','preparing','packing','ready','completed','cancelled')),
  total             NUMERIC(10,2) NOT NULL DEFAULT 0,
  note              TEXT        NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopbook_order_shop ON shopbook_order(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopbook_order_customer ON shopbook_order(customer_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shopbook_order_item (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID        NOT NULL REFERENCES shopbook_order(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  brand      TEXT        NOT NULL DEFAULT '',
  qty        NUMERIC(10,2) NOT NULL DEFAULT 1,
  price      NUMERIC(10,2) NOT NULL DEFAULT 0,
  note       TEXT        NOT NULL DEFAULT '',
  -- availability, as decided by the shop owner during review:
  --   pending | available | unavailable | alternative
  availability TEXT      NOT NULL DEFAULT 'pending'
                 CHECK (availability IN ('pending','available','unavailable','alternative')),
  alt_name   TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_shopbook_order_item_order ON shopbook_order_item(order_id);

CREATE TABLE IF NOT EXISTS shopbook_ledger (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  customer_user_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT        NOT NULL CHECK (type IN ('purchase','payment')),
  amount            NUMERIC(10,2) NOT NULL DEFAULT 0,
  remark            TEXT        NOT NULL DEFAULT '',
  order_id          UUID        REFERENCES shopbook_order(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopbook_ledger_shop_cust
  ON shopbook_ledger(shop_id, customer_user_id, created_at DESC);
