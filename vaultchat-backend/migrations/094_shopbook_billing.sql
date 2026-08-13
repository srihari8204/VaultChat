-- 094_shopbook_billing.sql — SHOP BOOK billing, invoicing and payments
-- (P0-C / P0-D / P0-E). Idempotent.
--
-- Four things this adds, each of which the order table could not express:
--
--   1. WHAT WAS ACTUALLY PACKED. `qty` is what the customer asked for and must
--      never be overwritten — "I ordered 1 kg" is half of every dispute. What
--      the shop weighed out goes in fulfilled_qty, and the bill is priced from
--      that. 1 kg requested, 1.18 kg packed, ₹240/kg → ₹283.20, with both
--      numbers still on the record.
--
--   2. THE BILL AS DISTINCT FROM THE ORDER. A shop discount given at the
--      counter is not a coupon, and round-off is neither. They get their own
--      columns so the invoice can show each line of the breakdown honestly.
--
--   3. WHO THE BUYER IS, FOR TAX. A buyer who supplies a tax number is making
--      a business purchase and needs a compliant tax invoice; the same sale to
--      a walk-in needs no such document and must not show blank statutory
--      fields. One sale, two invoice shapes, chosen by buyer_tax.
--
--   4. PAYMENTS AS RECORDS, NOT A BALANCE. shopbook_payment holds method,
--      reference, status and an idempotency key. Invoice payment state is
--      DERIVED from the sum of its payments — never set by hand, so it cannot
--      drift from the money that actually arrived.

-- ── order items: requested vs fulfilled ───────────────────────────
-- NULL means "as requested" — the overwhelmingly common case, and it keeps
-- every existing row correct without a backfill.
ALTER TABLE shopbook_order_item
  ADD COLUMN IF NOT EXISTS fulfilled_qty NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS removed       BOOLEAN NOT NULL DEFAULT FALSE;

-- Weighing out a negative amount is not a thing.
ALTER TABLE shopbook_order_item DROP CONSTRAINT IF EXISTS shopbook_order_item_fulfilled_ok;
ALTER TABLE shopbook_order_item ADD CONSTRAINT shopbook_order_item_fulfilled_ok
  CHECK (fulfilled_qty IS NULL OR fulfilled_qty >= 0);

-- ── order: the counter's own adjustments ──────────────────────────
ALTER TABLE shopbook_order
  ADD COLUMN IF NOT EXISTS bill_discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS buyer_tax     JSONB         NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS billed_at     TIMESTAMPTZ;

ALTER TABLE shopbook_order DROP CONSTRAINT IF EXISTS shopbook_order_bill_discount_ok;
ALTER TABLE shopbook_order ADD CONSTRAINT shopbook_order_bill_discount_ok
  CHECK (bill_discount >= 0);

-- Round-off is a shop-by-shop convention (common in India, absent elsewhere),
-- so it is configuration, not a hardcoded rule.
ALTER TABLE shopbook_shop
  ADD COLUMN IF NOT EXISTS round_off_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- IANA zone, e.g. 'Asia/Kolkata'. Empty means UNKNOWN, and the server then
  -- refuses to judge business hours at all rather than judge them in UTC —
  -- a shop in Chennai would otherwise be "closed" all morning. Opening-hours
  -- enforcement switches on per shop, when the owner tells us where they are.
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT '';

-- ── invoices: shape, lifecycle, and the buyer ─────────────────────
ALTER TABLE shopbook_invoice
  ADD COLUMN IF NOT EXISTS kind   TEXT  NOT NULL DEFAULT 'retail',
  ADD COLUMN IF NOT EXISTS status TEXT  NOT NULL DEFAULT 'issued',
  ADD COLUMN IF NOT EXISTS buyer  JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS round_off NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE shopbook_invoice DROP CONSTRAINT IF EXISTS shopbook_invoice_kind_check;
ALTER TABLE shopbook_invoice ADD CONSTRAINT shopbook_invoice_kind_check
  CHECK (kind IN ('retail','tax'));

-- 'paid' / 'partially_paid' / 'unpaid' are NOT stored here: they are derived
-- from shopbook_payment. Only the lifecycle states an actor chooses live in
-- this column, so there is nothing to fall out of sync.
ALTER TABLE shopbook_invoice DROP CONSTRAINT IF EXISTS shopbook_invoice_status_check;
ALTER TABLE shopbook_invoice ADD CONSTRAINT shopbook_invoice_status_check
  CHECK (status IN ('draft','issued','cancelled','credited'));

-- ── payments ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopbook_payment (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          UUID          NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  customer_user_id UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id         UUID          REFERENCES shopbook_order(id) ON DELETE SET NULL,
  invoice_id       UUID          REFERENCES shopbook_invoice(id) ON DELETE SET NULL,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method           TEXT          NOT NULL DEFAULT 'cash'
                     CHECK (method IN ('cash','bank','upi','card','other')),
  -- 'captured' is the only state a manual entry may claim. A gateway will add
  -- 'pending'/'failed' and settle them itself — the app must never write
  -- 'captured' because a client said a payment succeeded.
  status           TEXT          NOT NULL DEFAULT 'captured'
                     CHECK (status IN ('pending','captured','failed','refunded')),
  reference        TEXT          NOT NULL DEFAULT '',   -- UPI ref, cheque no, txn id
  note             TEXT          NOT NULL DEFAULT '',
  actor_user_id    UUID          REFERENCES users(id) ON DELETE SET NULL,
  ledger_id        UUID          REFERENCES shopbook_ledger(id) ON DELETE SET NULL,
  idempotency_key  TEXT          NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopbook_payment_shop
  ON shopbook_payment(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopbook_payment_customer
  ON shopbook_payment(shop_id, customer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopbook_payment_invoice
  ON shopbook_payment(invoice_id) WHERE invoice_id IS NOT NULL;
-- The whole point: a retried payment request resolves to the payment already
-- taken, rather than charging the customer's khata twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_payment_idem
  ON shopbook_payment(shop_id, idempotency_key) WHERE idempotency_key <> '';

-- ── the shop↔customer relationship, and its credit limit ──────────
-- Until now this relationship was implied by "has an order or a ledger row".
-- Giving it a table is what lets a shop set a credit limit, and what P1-C's
-- staff permissions will scope against.
CREATE TABLE IF NOT EXISTS shopbook_customer (
  shop_id          UUID          NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  customer_user_id UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credit_limit     NUMERIC(12,2) NOT NULL DEFAULT 0,   -- 0 = no limit configured
  note             TEXT          NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shop_id, customer_user_id),
  CONSTRAINT shopbook_customer_limit_ok CHECK (credit_limit >= 0)
);

-- Backfill from the relationships that already exist, so credit limits and
-- staff scoping have something to attach to on day one.
INSERT INTO shopbook_customer (shop_id, customer_user_id)
SELECT DISTINCT shop_id, customer_user_id FROM shopbook_order
UNION
SELECT DISTINCT shop_id, customer_user_id FROM shopbook_ledger
ON CONFLICT DO NOTHING;

-- ── shop verification lifecycle (P1-D groundwork) ─────────────────
-- `approved` and `verified` are two booleans expressing five states badly:
-- nothing could say "we are looking at it" or "this shop is suspended".
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='shopbook_shop' AND column_name='verify_state') THEN
    ALTER TABLE shopbook_shop ADD COLUMN verify_state TEXT NOT NULL DEFAULT 'unverified';
    -- Carry the existing booleans across so no shop changes status silently.
    UPDATE shopbook_shop SET verify_state =
      CASE WHEN verified THEN 'verified'
           WHEN approved THEN 'unverified'
           ELSE 'pending_review' END;
  END IF;
END $$;

ALTER TABLE shopbook_shop DROP CONSTRAINT IF EXISTS shopbook_shop_verify_state_check;
ALTER TABLE shopbook_shop ADD CONSTRAINT shopbook_shop_verify_state_check
  CHECK (verify_state IN ('unverified','pending_review','verified','suspended','rejected'));

-- ── subscription entitlement (bug #8) ─────────────────────────────
-- `plan` was owner-writable, so any shop could POST itself onto Pro. The plan
-- column stays (everything reads it), but what it may be set TO now comes from
-- an entitlement row that only an admin or a verified purchase can create.
CREATE TABLE IF NOT EXISTS shopbook_entitlement (
  shop_id     UUID PRIMARY KEY REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  plan        TEXT        NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
  state       TEXT        NOT NULL DEFAULT 'active'
                CHECK (state IN ('trial','active','past_due','grace_period','expired','cancelled')),
  source      TEXT        NOT NULL DEFAULT 'admin',   -- admin | play | appstore | manual
  reference   TEXT        NOT NULL DEFAULT '',        -- store purchase token, invoice no
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,                            -- NULL = no expiry
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Grandfather every shop currently on Pro: they were let in under the old
-- rule, and revoking their plan during a migration would be a silent outage.
INSERT INTO shopbook_entitlement (shop_id, plan, state, source, reference)
SELECT id, plan, 'active', 'manual', 'grandfathered at 094'
  FROM shopbook_shop WHERE plan = 'pro'
ON CONFLICT (shop_id) DO NOTHING;
