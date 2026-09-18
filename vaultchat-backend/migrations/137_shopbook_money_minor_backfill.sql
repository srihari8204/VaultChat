-- 137_shopbook_money_minor_backfill.sql — fill the minor-unit columns 136 added.
--
-- NOT APPLIED ANYWHERE. Local/scratch only.
--
-- SEPARATE FROM 136 ON PURPOSE. 136 changes the shape and writes no money; this
-- writes money and changes no shape. Either can be applied, inspected and
-- reverted without the other, and this one can be re-run — every statement is
-- idempotent (`WHERE <col>_minor IS NULL`), so a half-finished run resumes
-- rather than double-counting.
--
-- THE CONVERSION
-- --------------
--   minor = ROUND(decimal * 10^exponent)
--
-- ROUND() in Postgres on NUMERIC is half-away-from-zero, which is what the rest
-- of this codebase already does: divRound() and sbRoundOff() in
-- internal/routes/shopbook_money.go, Math.round in utils/money.ts (pinned by
-- moneySeam.selftest as "toPaise rounds half-up") and in formatMoney (pinned by
-- shopbook.selftest as formatMoney(10.005,'£') === '£10.01'). NOT half-even:
-- half-even would make that last one £10.00, i.e. a displayed value moving for
-- an existing user, which this change must never do.
--
-- Since every source column is NUMERIC(_,2) and every currency in
-- shopbook_country today is exponent 2, ROUND() is a no-op on real data:
-- 283.20 * 100 = 28320 exactly, in decimal, with nothing to round. The ROUND is
-- there for the 3dp case a later shop may bring, not for today's rows.
--
-- THE EXPONENT
-- ------------
-- sb_minor_exponent() below is a ONE-SHOT BACKFILL CONSTANT, not a runtime
-- lookup, and deliberately not a column: the authority is
-- internal/routes/shopbook_currency.go (server) and utils/currencyMinor.ts
-- (client), pinned to each other by utils/currencyMinor.selftest.ts. A third
-- copy that the application reads would be a third thing to drift. This one is
-- dropped again at the end of the migration so it cannot become one.
--
-- shopbook_shop.currency holds a SYMBOL ('₹'), never an ISO code — the code
-- lives on shopbook_country.currency_code — so every join here goes through
-- shopbook_country. A shop whose country is missing from shopbook_country gets
-- NO backfill (its rows keep reading from the decimal column) rather than a
-- guessed exponent 2. An unknown currency must fail loudly, and here failing
-- loudly means declining to write a number nobody can vouch for.
--
-- DOWN: migrations/down/137_shopbook_money_minor_backfill.sql — sets every
-- backfilled column back to NULL. Genuinely reversible: the decimal columns are
-- still authoritative and were not touched by this migration.

BEGIN;

CREATE OR REPLACE FUNCTION sb_minor_exponent(code TEXT) RETURNS INT AS $$
  SELECT CASE UPPER(TRIM(code))
    -- exponent 0 — no minor unit
    WHEN 'BIF' THEN 0 WHEN 'CLP' THEN 0 WHEN 'DJF' THEN 0 WHEN 'GNF' THEN 0
    WHEN 'ISK' THEN 0 WHEN 'JPY' THEN 0 WHEN 'KMF' THEN 0 WHEN 'KRW' THEN 0
    WHEN 'PYG' THEN 0 WHEN 'RWF' THEN 0 WHEN 'UGX' THEN 0 WHEN 'UYI' THEN 0
    WHEN 'VND' THEN 0 WHEN 'VUV' THEN 0 WHEN 'XAF' THEN 0 WHEN 'XOF' THEN 0
    WHEN 'XPF' THEN 0
    -- exponent 3 — three decimals
    WHEN 'BHD' THEN 3 WHEN 'IQD' THEN 3 WHEN 'JOD' THEN 3 WHEN 'KWD' THEN 3
    WHEN 'LYD' THEN 3 WHEN 'OMR' THEN 3 WHEN 'TND' THEN 3
    -- exponent 2 — an ALLOWLIST. An unlisted code returns NULL, and every
    -- expression below then writes NULL, i.e. leaves the row reading from its
    -- decimal column. Silence beats a guessed scale.
    WHEN 'AED' THEN 2 WHEN 'ARS' THEN 2 WHEN 'AUD' THEN 2 WHEN 'BDT' THEN 2
    WHEN 'BND' THEN 2 WHEN 'BRL' THEN 2 WHEN 'CAD' THEN 2 WHEN 'CHF' THEN 2
    WHEN 'CNY' THEN 2 WHEN 'COP' THEN 2 WHEN 'CZK' THEN 2 WHEN 'DKK' THEN 2
    WHEN 'EGP' THEN 2 WHEN 'EUR' THEN 2 WHEN 'GBP' THEN 2 WHEN 'HKD' THEN 2
    WHEN 'IDR' THEN 2 WHEN 'ILS' THEN 2 WHEN 'INR' THEN 2 WHEN 'KES' THEN 2
    WHEN 'LKR' THEN 2 WHEN 'MAD' THEN 2 WHEN 'MMK' THEN 2 WHEN 'MXN' THEN 2
    WHEN 'MYR' THEN 2 WHEN 'NGN' THEN 2 WHEN 'NOK' THEN 2 WHEN 'NPR' THEN 2
    WHEN 'NZD' THEN 2 WHEN 'PHP' THEN 2 WHEN 'PKR' THEN 2 WHEN 'PLN' THEN 2
    WHEN 'QAR' THEN 2 WHEN 'RON' THEN 2 WHEN 'RUB' THEN 2 WHEN 'SAR' THEN 2
    WHEN 'SEK' THEN 2 WHEN 'SGD' THEN 2 WHEN 'THB' THEN 2 WHEN 'TRY' THEN 2
    WHEN 'TWD' THEN 2 WHEN 'TZS' THEN 2 WHEN 'UAH' THEN 2 WHEN 'USD' THEN 2
    WHEN 'ZAR' THEN 2
    ELSE NULL
  END;
$$ LANGUAGE SQL IMMUTABLE;

-- Every shop's scale, resolved once through its country.
CREATE TEMP TABLE sb_shop_exp ON COMMIT DROP AS
SELECT s.id AS shop_id, sb_minor_exponent(c.currency_code) AS exp
  FROM shopbook_shop s
  JOIN shopbook_country c ON c.code = s.country;

CREATE UNIQUE INDEX ON sb_shop_exp(shop_id);

-- ── shop ──────────────────────────────────────────────────────────
UPDATE shopbook_shop s SET delivery_fee_minor = ROUND(s.delivery_fee * 10 ^ e.exp)
  FROM sb_shop_exp e WHERE e.shop_id = s.id AND e.exp IS NOT NULL
   AND s.delivery_fee_minor IS NULL;

-- ── catalog ───────────────────────────────────────────────────────
UPDATE shopbook_product p SET
    price_minor      = ROUND(p.price      * 10 ^ e.exp),
    cost_price_minor = ROUND(p.cost_price * 10 ^ e.exp),
    avg_cost_minor   = ROUND(p.avg_cost   * 10 ^ e.exp)
  FROM sb_shop_exp e WHERE e.shop_id = p.shop_id AND e.exp IS NOT NULL
   AND p.price_minor IS NULL;

-- ── orders ────────────────────────────────────────────────────────
UPDATE shopbook_order o SET
    subtotal_minor      = ROUND(o.subtotal      * 10 ^ e.exp),
    discount_minor      = ROUND(o.discount      * 10 ^ e.exp),
    bill_discount_minor = ROUND(o.bill_discount * 10 ^ e.exp),
    tax_total_minor     = ROUND(o.tax_total     * 10 ^ e.exp),
    delivery_fee_minor  = ROUND(o.delivery_fee  * 10 ^ e.exp),
    round_off_minor     = ROUND(o.round_off     * 10 ^ e.exp),
    total_minor         = ROUND(o.total         * 10 ^ e.exp)
  FROM sb_shop_exp e WHERE e.shop_id = o.shop_id AND e.exp IS NOT NULL
   AND o.total_minor IS NULL;

UPDATE shopbook_order_item i SET
    price_minor         = ROUND(i.price         * 10 ^ e.exp),
    alt_price_minor     = ROUND(i.alt_price     * 10 ^ e.exp),
    line_discount_minor = ROUND(i.line_discount * 10 ^ e.exp),
    line_tax_minor      = ROUND(i.line_tax      * 10 ^ e.exp),
    line_total_minor    = ROUND(i.line_total    * 10 ^ e.exp),
    cost_at_sale_minor  = ROUND(i.cost_at_sale  * 10 ^ e.exp)
  FROM shopbook_order o, sb_shop_exp e
 WHERE o.id = i.order_id AND e.shop_id = o.shop_id AND e.exp IS NOT NULL
   AND i.line_total_minor IS NULL;

-- ── invoices ──────────────────────────────────────────────────────
UPDATE shopbook_invoice v SET
    subtotal_minor  = ROUND(v.subtotal  * 10 ^ e.exp),
    discount_minor  = ROUND(v.discount  * 10 ^ e.exp),
    tax_total_minor = ROUND(v.tax_total * 10 ^ e.exp),
    total_minor     = ROUND(v.total     * 10 ^ e.exp)
  FROM sb_shop_exp e WHERE e.shop_id = v.shop_id AND e.exp IS NOT NULL
   AND v.total_minor IS NULL;

-- ── payments, credit limits ───────────────────────────────────────
UPDATE shopbook_payment pay SET amount_minor = ROUND(pay.amount * 10 ^ e.exp)
  FROM sb_shop_exp e WHERE e.shop_id = pay.shop_id AND e.exp IS NOT NULL
   AND pay.amount_minor IS NULL;

UPDATE shopbook_customer c SET credit_limit_minor = ROUND(c.credit_limit * 10 ^ e.exp)
  FROM sb_shop_exp e WHERE e.shop_id = c.shop_id AND e.exp IS NOT NULL
   AND c.credit_limit_minor IS NULL;

-- ── coupons ───────────────────────────────────────────────────────
-- `value` is money ONLY when kind='flat'; for kind='percent' it is a rate and
-- converting it would be meaningless (and would read back as 1800% tax-style
-- nonsense). min_order is always money.
UPDATE shopbook_coupon cp SET
    value_minor     = CASE WHEN cp.kind = 'flat'
                           THEN ROUND(cp.value * 10 ^ e.exp) END,
    min_order_minor = ROUND(cp.min_order * 10 ^ e.exp)
  FROM sb_shop_exp e WHERE e.shop_id = cp.shop_id AND e.exp IS NOT NULL
   AND cp.min_order_minor IS NULL;

-- One-shot only; see the header. Nothing may come to depend on this.
DROP FUNCTION sb_minor_exponent(TEXT);

COMMIT;
