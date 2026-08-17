-- 110_shopbook_documents.sql
-- Shop Book: one invoice document, four sources — and an itemised khata.
-- Idempotent.
--
-- WHAT WAS WRONG
--
--   ONE SOURCE. shopbook_invoice (069) hard-wired order_id NOT NULL UNIQUE and
--     customer_user_id NOT NULL. A document could therefore only ever describe
--     an app order placed by a registered user. The three things a kirana shop
--     actually hands paper for — goods given on credit at the counter, a
--     walk-in cash sale, and a payment against a khata — had no representation
--     at all. The alternative to fixing this is synthesising fake orders, which
--     would corrupt Today's Orders, the dashboard stats and the tax report.
--
--   NO ITEMS ON THE KHATA. shopbook_ledger (061) stores type + amount + remark.
--     A credit entry is "₹500, remark: groceries" — the shop cannot say WHAT it
--     gave, the customer cannot check it, and no invoice built from it can show
--     a priced line. shopbook_order_item has existed since 061; the ledger
--     simply never got the same treatment.
--
--   "IMMUTABLE" WAS A COMMENT. 069 calls the invoice table immutable and no
--     code updates it, but nothing stopped a future route from doing so. A
--     document that can be rewritten after issue is not a document.

-- ── khata line items ──────────────────────────────────────────────
-- Mirrors shopbook_order_item deliberately: same column names, same types, so
-- the invoice renderer reads one shape regardless of which table fed it.
CREATE TABLE IF NOT EXISTS shopbook_ledger_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id   UUID          NOT NULL REFERENCES shopbook_ledger(id) ON DELETE CASCADE,
  name        TEXT          NOT NULL,
  brand       TEXT          NOT NULL DEFAULT '',
  unit        TEXT          NOT NULL DEFAULT '',
  qty         NUMERIC(10,2) NOT NULL DEFAULT 1,
  price       NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_percent NUMERIC(5,2)  NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shopbook_ledger_item_ledger
  ON shopbook_ledger_item(ledger_id);

-- Entries become editable (owner corrects a wrong amount), so the stamp needs
-- somewhere to land. Existing rows inherit created_at's value, not NOW(), so
-- history is not retroactively claimed as "just edited".
ALTER TABLE shopbook_ledger ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE shopbook_ledger SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE shopbook_ledger ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE shopbook_ledger ALTER COLUMN updated_at SET NOT NULL;

-- ── invoice: four sources ─────────────────────────────────────────
ALTER TABLE shopbook_invoice
  ADD COLUMN IF NOT EXISTS source       TEXT NOT NULL DEFAULT 'order',
  ADD COLUMN IF NOT EXISTS ledger_id    UUID REFERENCES shopbook_ledger(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS walkin_name  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS walkin_phone TEXT NOT NULL DEFAULT '';

-- Every pre-existing row IS an order invoice, which is exactly what the column
-- default says. No backfill statement, and none needed.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shopbook_invoice_source_ck') THEN
    ALTER TABLE shopbook_invoice ADD CONSTRAINT shopbook_invoice_source_ck
      CHECK (source IN ('order','khata','counter','receipt'));
  END IF;
END $$;

-- order_id / customer_user_id stop being universally required. They stay
-- required for the sources that genuinely have them — enforced below, per
-- source, rather than by a blanket NOT NULL that only one source can satisfy.
ALTER TABLE shopbook_invoice ALTER COLUMN order_id         DROP NOT NULL;
ALTER TABLE shopbook_invoice ALTER COLUMN customer_user_id DROP NOT NULL;

-- The UNIQUE from 069 was a table constraint, and a table constraint cannot be
-- partial. Dropping it would lose "one invoice per order" for NULL-free rows,
-- so it is replaced by a partial unique INDEX with identical effect on real
-- order ids while permitting many NULLs (Postgres treats NULLs as distinct
-- anyway, but being explicit here documents the intent).
ALTER TABLE shopbook_invoice DROP CONSTRAINT IF EXISTS shopbook_invoice_order_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_invoice_order_once
  ON shopbook_invoice(order_id) WHERE order_id IS NOT NULL;

-- A khata credit entry likewise gets at most one invoice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_invoice_ledger_once
  ON shopbook_invoice(ledger_id) WHERE ledger_id IS NOT NULL;

-- Each source carries its own key. Without this the nullable columns above
-- would let a 'khata' invoice exist with no ledger_id and no customer — a
-- document pointing at nothing, discoverable only when it failed to render.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shopbook_invoice_source_keys_ck') THEN
    ALTER TABLE shopbook_invoice ADD CONSTRAINT shopbook_invoice_source_keys_ck CHECK (
      CASE source
        WHEN 'order'   THEN order_id IS NOT NULL AND customer_user_id IS NOT NULL
        WHEN 'khata'   THEN ledger_id IS NOT NULL AND customer_user_id IS NOT NULL
        WHEN 'receipt' THEN ledger_id IS NOT NULL AND customer_user_id IS NOT NULL
        -- a walk-in is by definition not a VaultChat user; a name is the only
        -- identity there is, and it may legitimately be blank for a cash sale.
        WHEN 'counter' THEN order_id IS NULL AND ledger_id IS NULL
        ELSE FALSE
      END
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shopbook_invoice_source
  ON shopbook_invoice(shop_id, source, created_at DESC);

-- ── invoice immutability, enforced ────────────────────────────────
-- 069 called this table immutable and nothing has ever updated it. That was a
-- convention held up by nobody happening to break it. Same pattern as
-- shopbook_audit (095): refuse in the database so a future route cannot
-- quietly start rewriting issued documents.
--
-- UPDATE ONLY, deliberately. shop_id and order_id are both ON DELETE CASCADE,
-- so a BEFORE DELETE trigger here would abort any attempt to delete a shop or
-- an order — the cascade fires row-level DELETEs against this table and the
-- exception propagates. Rewriting an issued document is the thing being
-- prevented; erasing a shop's records wholesale is a different operation with
-- its own (deletion / retention) rules, and must stay possible.
--
-- CONTENT is frozen; `status` is NOT. 094 defines draft/issued/cancelled/
-- credited as "the lifecycle states an actor chooses", so a blanket UPDATE ban
-- would make cancelling or crediting an invoice permanently impossible — it
-- would silently delete a designed capability rather than protect anything.
-- That is also how invoicing works outside software: you never edit an issued
-- document's numbers, you cancel it or raise a credit note against it.
--
-- Compared as jsonb-minus-status rather than by listing 23 columns, so a
-- column added by a later migration is frozen automatically instead of
-- becoming a silent hole in the guarantee.
CREATE OR REPLACE FUNCTION shopbook_invoice_is_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF to_jsonb(NEW) - 'status' IS DISTINCT FROM to_jsonb(OLD) - 'status' THEN
    RAISE EXCEPTION
      'shopbook_invoice is immutable once issued — only status may change (cancel or credit it instead)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shopbook_invoice_no_change ON shopbook_invoice;
CREATE TRIGGER shopbook_invoice_no_change
  BEFORE UPDATE ON shopbook_invoice
  FOR EACH ROW EXECUTE FUNCTION shopbook_invoice_is_immutable();
