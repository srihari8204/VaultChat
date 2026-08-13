-- 095_shopbook_purchases_returns.sql — SHOP BOOK purchases, returns and the
-- shop audit log (P1-A / P1-B / P1-F). Idempotent.
--
-- The three things a shop can currently do to its own records without leaving
-- a trace, and the one number it cannot compute:
--
--   PURCHASES. Stock could only arrive by hand-typed adjustment, which records
--     a quantity and nothing about what it cost. Without a purchase price
--     there is no cost of goods, and without cost of goods "profit" is a
--     number the app would have to invent. A purchase now creates its own
--     stock-in movement, so the same event cannot be recorded twice by hand.
--
--   RETURNS. A completed order was final. Goods came back across the counter
--     and the only way to reflect it was to edit history — which is precisely
--     what a finalized invoice must not permit. Returns get their own record,
--     their own approval, their own stock movement, and a CREDIT NOTE that
--     sits alongside the original invoice rather than altering it.
--
--   AUDIT. shopbook_admin_log covers the platform admin. Nothing covered the
--     shop: price edits, stock corrections, ledger adjustments, cancellations
--     and refunds all happened silently. An audit trail that only records
--     strangers is not an audit trail.

-- ── purchases ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopbook_purchase (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         UUID          NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  supplier_id     UUID          REFERENCES shopbook_supplier(id) ON DELETE SET NULL,
  supplier_name   TEXT          NOT NULL DEFAULT '',   -- snapshot; suppliers get renamed
  invoice_number  TEXT          NOT NULL DEFAULT '',   -- the SUPPLIER's invoice no
  purchased_on    DATE          NOT NULL DEFAULT CURRENT_DATE,
  subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_total       NUMERIC(12,2) NOT NULL DEFAULT 0,
  total           NUMERIC(12,2) NOT NULL DEFAULT 0,
  note            TEXT          NOT NULL DEFAULT '',
  actor_user_id   UUID          REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT          NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT shopbook_purchase_amounts_ok
    CHECK (subtotal >= 0 AND tax_total >= 0 AND total >= 0)
);
CREATE INDEX IF NOT EXISTS idx_shopbook_purchase_shop
  ON shopbook_purchase(shop_id, purchased_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_purchase_idem
  ON shopbook_purchase(shop_id, idempotency_key) WHERE idempotency_key <> '';
-- Two entries of the same supplier invoice is the most common double-count in
-- a paper-to-app migration. Same shop + same supplier + same invoice number =
-- the same delivery.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_purchase_supplier_invoice
  ON shopbook_purchase(shop_id, lower(supplier_name), lower(invoice_number))
  WHERE invoice_number <> '';

CREATE TABLE IF NOT EXISTS shopbook_purchase_item (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id  UUID          NOT NULL REFERENCES shopbook_purchase(id) ON DELETE CASCADE,
  product_id   UUID          REFERENCES shopbook_product(id) ON DELETE SET NULL,
  name         TEXT          NOT NULL,          -- snapshot: products get renamed
  unit         TEXT          NOT NULL DEFAULT '',
  qty          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (qty > 0),
  cost_price   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  tax_percent  NUMERIC(5,2)  NOT NULL DEFAULT 0,
  line_tax     NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total   NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shopbook_purchase_item
  ON shopbook_purchase_item(purchase_id);
-- Margin reporting asks "what did this product cost me lately?" per product.
CREATE INDEX IF NOT EXISTS idx_shopbook_purchase_item_product
  ON shopbook_purchase_item(product_id) WHERE product_id IS NOT NULL;

-- Running average cost, maintained per purchase so the margin on a sale can be
-- read without walking every purchase ever made. Latest cost lives on
-- shopbook_product.cost_price (094); this is the weighted one.
ALTER TABLE shopbook_product
  ADD COLUMN IF NOT EXISTS avg_cost      NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_cost_qty  NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ── returns ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopbook_return (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  order_id         UUID        NOT NULL REFERENCES shopbook_order(id) ON DELETE CASCADE,
  customer_user_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           TEXT        NOT NULL DEFAULT 'requested'
                     CHECK (status IN ('requested','approved','rejected','completed')),
  reason           TEXT        NOT NULL DEFAULT '',
  -- Why the shop said no. Required on rejection: "returns rejected" with no
  -- reason is the single most common complaint about any returns process.
  decision_note    TEXT        NOT NULL DEFAULT '',
  -- 'refund' hands money back; 'credit' leaves it on the khata. Both produce a
  -- credit note; they differ in whether cash moves.
  settlement       TEXT        NOT NULL DEFAULT 'credit'
                     CHECK (settlement IN ('refund','credit')),
  refund_total     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (refund_total >= 0),
  restock          BOOLEAN     NOT NULL DEFAULT TRUE,   -- damaged goods do not go back
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at       TIMESTAMPTZ,
  decided_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key  TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_shopbook_return_shop
  ON shopbook_return(shop_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopbook_return_customer
  ON shopbook_return(customer_user_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_return_idem
  ON shopbook_return(shop_id, idempotency_key) WHERE idempotency_key <> '';
-- One open return per order. A customer tapping twice must not open two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_return_one_open
  ON shopbook_return(order_id) WHERE status IN ('requested','approved');

CREATE TABLE IF NOT EXISTS shopbook_return_item (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id     UUID          NOT NULL REFERENCES shopbook_return(id) ON DELETE CASCADE,
  order_item_id UUID          NOT NULL REFERENCES shopbook_order_item(id) ON DELETE CASCADE,
  product_id    UUID          REFERENCES shopbook_product(id) ON DELETE SET NULL,
  name          TEXT          NOT NULL,
  unit          TEXT          NOT NULL DEFAULT '',
  qty           NUMERIC(12,2) NOT NULL CHECK (qty > 0),
  -- Refund value is derived from the ORIGINAL line price, never re-quoted:
  -- a price rise between sale and return must not change what is owed back.
  unit_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_tax      NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total    NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shopbook_return_item ON shopbook_return_item(return_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_return_item_once
  ON shopbook_return_item(return_id, order_item_id);

-- ── credit / debit notes ──────────────────────────────────────────
-- A correction that sits BESIDE the invoice. The original is never touched —
-- that is the whole point, and it is what makes the tax records defensible.
CREATE TABLE IF NOT EXISTS shopbook_credit_note (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          UUID          NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  invoice_id       UUID          NOT NULL REFERENCES shopbook_invoice(id) ON DELETE CASCADE,
  return_id        UUID          REFERENCES shopbook_return(id) ON DELETE SET NULL,
  customer_user_id UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT          NOT NULL DEFAULT 'credit' CHECK (kind IN ('credit','debit')),
  number           INT           NOT NULL,     -- per shop, per kind, sequential
  reason           TEXT          NOT NULL DEFAULT '',
  subtotal         NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_total        NUMERIC(12,2) NOT NULL DEFAULT 0,
  total            NUMERIC(12,2) NOT NULL DEFAULT 0,
  items            JSONB         NOT NULL DEFAULT '[]',
  tax_breakdown    JSONB         NOT NULL DEFAULT '[]',
  business         JSONB         NOT NULL DEFAULT '{}',
  customer_name    TEXT          NOT NULL DEFAULT '',
  currency         TEXT          NOT NULL DEFAULT '₹',
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, kind, number)
);
CREATE INDEX IF NOT EXISTS idx_shopbook_credit_note_invoice
  ON shopbook_credit_note(invoice_id);
CREATE INDEX IF NOT EXISTS idx_shopbook_credit_note_customer
  ON shopbook_credit_note(customer_user_id, created_at DESC);

-- Separate counters per note kind, alongside the existing invoice_seq.
ALTER TABLE shopbook_shop
  ADD COLUMN IF NOT EXISTS credit_note_seq INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS debit_note_seq  INT NOT NULL DEFAULT 0;

-- A refund is money leaving. It belongs in the ledger as its own type, not as
-- a negative purchase — the amount CHECK from 092 would reject that anyway.
ALTER TABLE shopbook_ledger DROP CONSTRAINT IF EXISTS shopbook_ledger_type_check;
ALTER TABLE shopbook_ledger ADD CONSTRAINT shopbook_ledger_type_check
  CHECK (type IN ('purchase','payment','credit_note','refund'));

-- ── shop audit log (P1-F) ─────────────────────────────────────────
-- Deliberately NOT reusing shopbook_admin_log: that one is platform-scoped and
-- readable by admins, this one is shop-scoped and readable by the owner. Two
-- audiences, two access rules, two tables.
CREATE TABLE IF NOT EXISTS shopbook_audit (
  id            BIGSERIAL PRIMARY KEY,
  shop_id       UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  actor_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  actor_role    TEXT        NOT NULL DEFAULT 'owner',
  action        TEXT        NOT NULL,          -- price.change, stock.adjust, ledger.entry…
  entity        TEXT        NOT NULL DEFAULT '',
  entity_id     TEXT        NOT NULL DEFAULT '',
  before        JSONB       NOT NULL DEFAULT '{}',
  after         JSONB       NOT NULL DEFAULT '{}',
  reason        TEXT        NOT NULL DEFAULT '',
  ip            TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopbook_audit_shop
  ON shopbook_audit(shop_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_shopbook_audit_entity
  ON shopbook_audit(shop_id, entity, entity_id, id DESC);

-- No UPDATE and no DELETE, for anybody. An audit row that the audited party
-- can edit records nothing. Enforced here rather than in the handler so a
-- future route cannot forget.
CREATE OR REPLACE FUNCTION shopbook_audit_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'shopbook_audit is append-only (attempted %)', TG_OP;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shopbook_audit_no_update ON shopbook_audit;
CREATE TRIGGER shopbook_audit_no_update
  BEFORE UPDATE OR DELETE ON shopbook_audit
  FOR EACH ROW EXECUTE FUNCTION shopbook_audit_is_append_only();
