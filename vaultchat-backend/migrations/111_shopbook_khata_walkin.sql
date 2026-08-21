-- 111_shopbook_khata_walkin.sql
-- Shop Book: a khata for a customer who does not have VaultChat.
-- Idempotent. ADDITIVE ONLY — no existing row changes, no existing query breaks.
--
-- WHAT IS MISSING
--
--   110 gave the INVOICE four sources, and one of them ('counter') is the
--     walk-in cash sale: walkin_name / walkin_phone, with customer_user_id
--     relaxed to NULL. But that source is constrained to
--     `order_id IS NULL AND ledger_id IS NULL` — deliberately, because a cash
--     sale is a one-off document and not a relationship.
--
--   THE KHATA ITSELF STILL REQUIRES AN ACCOUNT. shopbook_ledger (061) declares
--     customer_user_id UUID NOT NULL REFERENCES users(id). So the single most
--     common thing a kirana shop does — give goods on credit to a neighbour who
--     will never install the app, and carry that balance for weeks — cannot be
--     recorded at all. That is the gap this migration closes, and the only one.
--
--   CASCADE TAKES THE SHOP'S MONEY WITH IT. 061's customer_user_id carries
--     ON DELETE CASCADE. When a customer deletes their VaultChat account, every
--     khata line naming them is deleted at every shop, and the derived balance
--     silently changes with no audit trail. The shop's receivable disappears
--     because of an action taken by the person who owed it.
--
--     The existing column's CASCADE is LEFT ALONE here: changing it would alter
--     how account deletion behaves for data that already exists, which is a
--     product decision and not a migration's to make. The new link below uses
--     SET NULL so the same mistake is not repeated for new rows.
--
-- FOLLOWS 110's PATTERN EXACTLY: relax the blanket NOT NULL, add a per-shape
-- CHECK so nothing can point at nothing, and use partial indexes rather than
-- table constraints so the nullable case stays legal.

-- ── the shop's own contact record ─────────────────────────────────
-- Owned by the SHOP, not by the platform: this is the shopkeeper's address
-- book, not a user account. linked_user_id is an optional convenience for the
-- day the customer does install VaultChat, and is SET NULL on delete so the
-- ledger outlives the account (see CASCADE note above).
CREATE TABLE IF NOT EXISTS shopbook_khata_customer (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  mobile         TEXT        NOT NULL DEFAULT '',
  alt_mobile     TEXT        NOT NULL DEFAULT '',
  address        TEXT        NOT NULL DEFAULT '',
  notes          TEXT        NOT NULL DEFAULT '',
  linked_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  -- Offline provenance. The pair is what the sync layer turns into an
  -- idempotency key; kept here too so a customer created on a plane can be
  -- recognised as the same customer when a second device syncs it.
  device_id      TEXT        NOT NULL DEFAULT '',
  local_id       TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shopbook_khata_customer_name_ck CHECK (length(btrim(name)) > 0)
);

-- One khata per phone number per shop. Partial, because mobile is genuinely
-- optional — a shop may keep a name-only khata for someone they know by sight.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_khata_customer_mobile
  ON shopbook_khata_customer(shop_id, mobile) WHERE mobile <> '';

-- The offline identity is unique per shop as well, so a retried sync of the
-- same locally-created customer cannot produce two contact records.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_khata_customer_local
  ON shopbook_khata_customer(shop_id, device_id, local_id)
  WHERE device_id <> '' AND local_id <> '';

CREATE INDEX IF NOT EXISTS idx_shopbook_khata_customer_shop
  ON shopbook_khata_customer(shop_id, name);

-- ── the ledger learns a second kind of party ──────────────────────
ALTER TABLE shopbook_ledger
  ADD COLUMN IF NOT EXISTS khata_customer_id UUID
    REFERENCES shopbook_khata_customer(id) ON DELETE RESTRICT;

-- Relaxed, not removed. Every pre-existing row has customer_user_id set and is
-- unaffected; the CHECK below is what keeps the column honest from here on.
-- RESTRICT above is deliberate: a contact with ledger history must be settled
-- or explicitly reassigned, never silently deleted out from under its balance.
ALTER TABLE shopbook_ledger ALTER COLUMN customer_user_id DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shopbook_ledger_party_ck') THEN
    ALTER TABLE shopbook_ledger ADD CONSTRAINT shopbook_ledger_party_ck CHECK (
      (customer_user_id IS NOT NULL AND khata_customer_id IS NULL)
      OR
      (customer_user_id IS NULL AND khata_customer_id IS NOT NULL)
    );
  END IF;
END $$;

-- 061's idx_shopbook_ledger_shop_cust cannot serve the new party: its leading
-- edge is customer_user_id, which is NULL for every walk-in line. The mirror
-- index gives walk-in ledgers the same "newest first, per customer" read the
-- account-holder path already has.
CREATE INDEX IF NOT EXISTS idx_shopbook_ledger_shop_khata
  ON shopbook_ledger(shop_id, khata_customer_id, created_at DESC)
  WHERE khata_customer_id IS NOT NULL;

-- ── offline provenance on the transaction itself ──────────────────
-- idempotency_key (092) already carries "<device>:<local>" and already has a
-- partial unique index on (shop_id, idempotency_key), so duplicate protection
-- needs nothing new. These two columns exist to ANSWER QUESTIONS afterwards —
-- which device recorded this, was it entered offline — without parsing a key
-- whose format is an implementation detail.
ALTER TABLE shopbook_ledger
  ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS entered_offline BOOLEAN NOT NULL DEFAULT FALSE;
