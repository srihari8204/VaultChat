-- 136_shopbook_money_minor.sql — additive int64 minor-unit columns for Shop Book money.
--
-- NOT APPLIED ANYWHERE. Local/scratch only so far. This file adds columns; it
-- writes no money. The backfill is 137, deliberately separate, so this one can
-- be applied and left alone while the shape is watched.
--
-- WHAT IS WRONG TODAY
-- -------------------
-- Every Shop Book money column is NUMERIC(_,2) and every boundary crossing is a
-- hard-coded x100 (internal/routes/shopbook_money.go: sbCents/sbAmt/Float).
-- Scale 2 is not a property of money, it is a property of the CURRENCY:
--
--   exponent 0  JPY KRW VND CLP ISK PYG RWF UGX VUV XAF XOF XPF KMF DJF GNF
--               A yen has no minor unit. NUMERIC(12,2) stores 1299.00 for
--               ¥1299 and the x100 seam reads it as 129900 minor units. That
--               is only self-consistent because BOTH ends are wrong by the
--               same factor; the moment a real ISO exponent is applied
--               anywhere — a payment gateway, an export, an accountant — it is
--               a hundredfold error.
--   exponent 3  BHD KWD JOD TND OMR LYD IQD
--               NUMERIC(12,2) CANNOT HOLD 1.234 KD. Postgres rounds it to 1.23
--               on write, silently, before anyone can read it back. There is no
--               recovery from that; only prevention.
--
-- The authority for code -> exponent is ONE place per runtime:
--   vaultchat-backend-go/internal/routes/shopbook_currency.go   (server)
--   VaultChat/utils/currencyMinor.ts                            (client)
-- and the two are pinned against each other by utils/currencyMinor.selftest.ts.
-- SQL deliberately does NOT get a third copy: no runtime lookup is added here.
--
-- WHY THIS IS SAFE FOR EVERY EXISTING SHOP
-- ----------------------------------------
-- shopbook_country seeds six countries (migration 069): IN/INR, US/USD,
-- GB/GBP, AU/AUD, CA/CAD, SG/SGD. All six are exponent 2. So for every shop
-- that exists today the new representation and the old one hold the SAME
-- number, and no displayed value can move. The 0dp/3dp cases are currencies
-- this schema could not have served correctly, not ones it is serving wrongly.
--
-- ADDITIVE, AS REQUIRED
-- ---------------------
-- Columns are ADDED. Nothing is dropped, nothing is retyped, no NUMERIC column
-- changes. The decimal columns stay authoritative until a later cutover, so a
-- rollback is a code rollback, not a data restore.
--
-- NULLABLE, AND NULL MEANS SOMETHING
-- ----------------------------------
-- NULL = "not backfilled yet, read the decimal column". That is exactly what
-- readMoney() in utils/currencyMinor.ts keys on, and it is why these are not
-- `NOT NULL DEFAULT 0` — a defaulted 0 is indistinguishable from a genuine
-- zero amount, and the read path would have no way to know which rows are
-- trustworthy. It also keeps the ALTER metadata-only on every row.
--
-- DOWN: migrations/down/136_shopbook_money_minor.sql — drops exactly these
-- columns. Lossless while 137 has not run and nothing writes minor units yet.

BEGIN;

ALTER TABLE shopbook_shop
  ADD COLUMN IF NOT EXISTS delivery_fee_minor  BIGINT;

ALTER TABLE shopbook_product
  ADD COLUMN IF NOT EXISTS price_minor         BIGINT,
  ADD COLUMN IF NOT EXISTS cost_price_minor    BIGINT,
  ADD COLUMN IF NOT EXISTS avg_cost_minor      BIGINT;

ALTER TABLE shopbook_order
  ADD COLUMN IF NOT EXISTS subtotal_minor      BIGINT,
  ADD COLUMN IF NOT EXISTS discount_minor      BIGINT,
  ADD COLUMN IF NOT EXISTS bill_discount_minor BIGINT,
  ADD COLUMN IF NOT EXISTS tax_total_minor     BIGINT,
  ADD COLUMN IF NOT EXISTS delivery_fee_minor  BIGINT,
  ADD COLUMN IF NOT EXISTS round_off_minor     BIGINT,
  ADD COLUMN IF NOT EXISTS total_minor         BIGINT;

ALTER TABLE shopbook_order_item
  ADD COLUMN IF NOT EXISTS price_minor         BIGINT,
  ADD COLUMN IF NOT EXISTS alt_price_minor     BIGINT,
  ADD COLUMN IF NOT EXISTS line_discount_minor BIGINT,
  ADD COLUMN IF NOT EXISTS line_tax_minor      BIGINT,
  ADD COLUMN IF NOT EXISTS line_total_minor    BIGINT,
  ADD COLUMN IF NOT EXISTS cost_at_sale_minor  BIGINT;

ALTER TABLE shopbook_invoice
  ADD COLUMN IF NOT EXISTS subtotal_minor      BIGINT,
  ADD COLUMN IF NOT EXISTS discount_minor      BIGINT,
  ADD COLUMN IF NOT EXISTS tax_total_minor     BIGINT,
  ADD COLUMN IF NOT EXISTS total_minor         BIGINT;

ALTER TABLE shopbook_payment
  ADD COLUMN IF NOT EXISTS amount_minor        BIGINT;

ALTER TABLE shopbook_customer
  ADD COLUMN IF NOT EXISTS credit_limit_minor  BIGINT;

-- shopbook_coupon.value is a percentage when kind='percent' and money when
-- kind='flat'. Only the flat case is money, so only the flat case gets a minor
-- column; min_order is always money.
ALTER TABLE shopbook_coupon
  ADD COLUMN IF NOT EXISTS value_minor         BIGINT,
  ADD COLUMN IF NOT EXISTS min_order_minor     BIGINT;

COMMIT;
