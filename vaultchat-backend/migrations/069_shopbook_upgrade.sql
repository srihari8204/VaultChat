-- 064_shopbook_upgrade.sql — SHOP BOOK upgrade (openspec: shop-book-upgrade).
-- Idempotent.
--
-- Adds the full order pipeline (pending → accepted → preparing → packing →
-- ready → collected → completed, plus rejected/cancelled with reasons and a
-- timestamped timeline), shop approval + verified badge, the Country Tax
-- Engine (server-seeded, admin-editable), invoices, a notification inbox,
-- server-managed category starter catalogs, and an admin action log.
--
-- Backward compatibility: existing shops are grandfathered as approved;
-- existing 'new' orders become 'pending'. Old Go binaries keep working —
-- every column is additive with a default, and the widened CHECKs accept
-- every status the old code writes.

-- ── shopbook_shop: approval, country/tax, invoice counter, statuses ─
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='shopbook_shop' AND column_name='approved') THEN
    ALTER TABLE shopbook_shop ADD COLUMN approved BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE shopbook_shop SET approved = TRUE;   -- grandfather existing shops
  END IF;
END $$;

ALTER TABLE shopbook_shop ADD COLUMN IF NOT EXISTS verified    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE shopbook_shop ADD COLUMN IF NOT EXISTS country     TEXT    NOT NULL DEFAULT 'IN';
ALTER TABLE shopbook_shop ADD COLUMN IF NOT EXISTS currency    TEXT    NOT NULL DEFAULT '₹';
ALTER TABLE shopbook_shop ADD COLUMN IF NOT EXISTS tax_config  JSONB   NOT NULL DEFAULT '{}';
ALTER TABLE shopbook_shop ADD COLUMN IF NOT EXISTS invoice_seq INT     NOT NULL DEFAULT 0;

-- Widen the status CHECK: + holiday, vacation (closing-soon stays derived).
ALTER TABLE shopbook_shop DROP CONSTRAINT IF EXISTS shopbook_shop_status_check;
ALTER TABLE shopbook_shop ADD CONSTRAINT shopbook_shop_status_check
  CHECK (status IN ('open','busy','closed','holiday','vacation'));

-- ── shopbook_order: full pipeline + reasons ────────────────────────
ALTER TABLE shopbook_order ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE shopbook_order ADD COLUMN IF NOT EXISTS cancelled_by  TEXT NOT NULL DEFAULT ''
  CHECK (cancelled_by IN ('','customer','owner'));
ALTER TABLE shopbook_order ADD COLUMN IF NOT EXISTS reject_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE shopbook_order DROP CONSTRAINT IF EXISTS shopbook_order_status_check;
UPDATE shopbook_order SET status='pending' WHERE status='new';
ALTER TABLE shopbook_order ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE shopbook_order ADD CONSTRAINT shopbook_order_status_check
  CHECK (status IN ('pending','accepted','preparing','packing','ready',
                    'collected','completed','rejected','cancelled'));

-- Timestamped status timeline (customer-facing order tracking).
CREATE TABLE IF NOT EXISTS shopbook_order_event (
  id        BIGSERIAL PRIMARY KEY,
  order_id  UUID        NOT NULL REFERENCES shopbook_order(id) ON DELETE CASCADE,
  status    TEXT        NOT NULL,
  note      TEXT        NOT NULL DEFAULT '',
  at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopbook_order_event ON shopbook_order_event(order_id, id);

-- ── products / order items: unit + tax snapshot, price freshness ───
ALTER TABLE shopbook_product ADD COLUMN IF NOT EXISTS tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE shopbook_product ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW();

ALTER TABLE shopbook_order_item ADD COLUMN IF NOT EXISTS unit        TEXT          NOT NULL DEFAULT '';
ALTER TABLE shopbook_order_item ADD COLUMN IF NOT EXISTS tax_percent NUMERIC(5,2)  NOT NULL DEFAULT 0;
ALTER TABLE shopbook_order_item ADD COLUMN IF NOT EXISTS alt_price   NUMERIC(10,2) NOT NULL DEFAULT 0;

-- ── invoices: immutable, per-shop sequential ───────────────────────
CREATE TABLE IF NOT EXISTS shopbook_invoice (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  order_id         UUID        NOT NULL UNIQUE REFERENCES shopbook_order(id) ON DELETE CASCADE,
  customer_user_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number           INT         NOT NULL,
  country          TEXT        NOT NULL DEFAULT 'IN',
  tax_type         TEXT        NOT NULL DEFAULT '',
  currency         TEXT        NOT NULL DEFAULT '₹',
  subtotal         NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount         NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_total        NUMERIC(10,2) NOT NULL DEFAULT 0,
  total            NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- resolved snapshots at issue time (admin edits never mutate history):
  business         JSONB       NOT NULL DEFAULT '{}',  -- shop name/address/phone + tax fields
  customer_name    TEXT        NOT NULL DEFAULT '',
  items            JSONB       NOT NULL DEFAULT '[]',  -- [{name,brand,unit,qty,price,taxPercent}]
  tax_breakdown    JSONB       NOT NULL DEFAULT '[]',  -- [{label,amount}] e.g. CGST/SGST split
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, number)
);
CREATE INDEX IF NOT EXISTS idx_shopbook_invoice_shop
  ON shopbook_invoice(shop_id, number DESC);
CREATE INDEX IF NOT EXISTS idx_shopbook_invoice_customer
  ON shopbook_invoice(customer_user_id, created_at DESC);

-- ── notification inbox (push copies persist here) ──────────────────
CREATE TABLE IF NOT EXISTS shopbook_notification (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL,
  body       TEXT        NOT NULL DEFAULT '',
  event      TEXT        NOT NULL DEFAULT '',
  data       JSONB       NOT NULL DEFAULT '{}',
  read       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopbook_notification_user
  ON shopbook_notification(user_id, created_at DESC);

-- ── Country Tax Engine (seeded, admin-editable, no app release) ────
CREATE TABLE IF NOT EXISTS shopbook_country (
  code            TEXT PRIMARY KEY,          -- ISO-3166 alpha-2
  name            TEXT NOT NULL,
  currency_symbol TEXT NOT NULL,
  currency_code   TEXT NOT NULL,
  tax_type        TEXT NOT NULL,             -- GST | VAT | Sales Tax | GST/HST/PST
  tax_split       JSONB NOT NULL DEFAULT '[]',  -- e.g. ["CGST","SGST"] halves the rate
  tax_fields      JSONB NOT NULL DEFAULT '[]',  -- [{id,label,type?}] all optional
  documents       JSONB NOT NULL DEFAULT '[]',  -- optional business documents
  date_format     TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
  sort            INT  NOT NULL DEFAULT 100,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO shopbook_country
  (code, name, currency_symbol, currency_code, tax_type, tax_split, tax_fields, documents, date_format, sort)
VALUES
  ('IN','India','₹','INR','GST','["CGST","SGST"]',
   '[{"id":"registered","label":"GST Registered","type":"bool"},
     {"id":"gstin","label":"GSTIN"},
     {"id":"hsn_sac","label":"HSN / SAC (Optional)"}]',
   '["GST Certificate","Shop License","FSSAI","Drug License"]',
   'DD/MM/YYYY', 1),
  ('US','United States','$','USD','Sales Tax','[]',
   '[{"id":"ein","label":"EIN"},
     {"id":"state_tax_id","label":"State Tax ID"}]',
   '["Business License"]',
   'MM/DD/YYYY', 2),
  ('GB','United Kingdom','£','GBP','VAT','[]',
   '[{"id":"vat_number","label":"VAT Registration Number"}]',
   '["Business Registration"]',
   'DD/MM/YYYY', 3),
  ('AU','Australia','A$','AUD','GST','[]',
   '[{"id":"abn","label":"ABN"},
     {"id":"registered","label":"GST Registered","type":"bool"}]',
   '[]',
   'DD/MM/YYYY', 4),
  ('CA','Canada','C$','CAD','GST/HST/PST','[]',
   '[{"id":"business_number","label":"Business Number"},
     {"id":"gst_hst_number","label":"GST/HST Number"}]',
   '[]',
   'DD/MM/YYYY', 5),
  ('SG','Singapore','S$','SGD','GST','[]',
   '[{"id":"gst_reg_number","label":"GST Registration Number"},
     {"id":"uen","label":"UEN"}]',
   '[]',
   'DD/MM/YYYY', 6)
ON CONFLICT (code) DO NOTHING;

-- ── categories + starter catalogs (server-managed) ─────────────────
CREATE TABLE IF NOT EXISTS shopbook_category (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  icon  TEXT NOT NULL DEFAULT '🏬',
  sort  INT  NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS shopbook_starter_item (
  id          BIGSERIAL PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES shopbook_category(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL DEFAULT '',
  sort        INT  NOT NULL DEFAULT 100,
  UNIQUE (category_id, name)
);

INSERT INTO shopbook_category (id, label, icon, sort) VALUES
  ('supermarket','Super Market','🛒',1), ('grocery','Grocery','🏪',2),
  ('vegetable','Vegetables','🥬',3),     ('fruit','Fruits','🍎',4),
  ('chicken','Chicken','🍗',5),          ('mutton','Mutton','🥩',6),
  ('fish','Fish','🐟',7),                ('bakery','Bakery','🍞',8),
  ('dairy','Dairy','🥛',9),              ('medical','Medical','💊',10),
  ('stationery','Stationery','✏️',11),   ('hardware','Hardware','🔧',12),
  ('electronics','Electronics','💻',13), ('pet','Pet Shop','🐾',14)
ON CONFLICT (id) DO NOTHING;

INSERT INTO shopbook_starter_item (category_id, name, unit, sort) VALUES
  -- supermarket: one starter row per section of the vision list
  ('supermarket','Rice','5kg',1), ('supermarket','Cooking Oil','1L',2),
  ('supermarket','Washing Powder','1kg',3), ('supermarket','Snacks Pack','1pc',4),
  ('supermarket','Soft Drink','1L',5), ('supermarket','Frozen Peas','500g',6),
  ('grocery','Rice','5kg',1), ('grocery','Cooking Oil','1L',2), ('grocery','Sugar','1kg',3),
  ('grocery','Flour (Atta)','5kg',4), ('grocery','Spices Pack','100g',5),
  ('grocery','Tea','250g',6), ('grocery','Coffee','100g',7),
  ('vegetable','Tomato','1kg',1), ('vegetable','Potato','1kg',2), ('vegetable','Onion','1kg',3),
  ('vegetable','Carrot','500g',4), ('vegetable','Beans','500g',5), ('vegetable','Leafy Vegetables','1 bunch',6),
  ('fruit','Apple','1kg',1), ('fruit','Banana','1 dozen',2), ('fruit','Orange','1kg',3),
  ('fruit','Mango','1kg',4), ('fruit','Grapes','500g',5), ('fruit','Seasonal Fruits','1kg',6),
  ('chicken','Whole Chicken','1kg',1), ('chicken','Curry Cut','1kg',2), ('chicken','Boneless','500g',3),
  ('chicken','Wings','500g',4), ('chicken','Liver','250g',5), ('chicken','Gizzard','250g',6),
  ('mutton','Boneless','500g',1), ('mutton','Curry Cut','1kg',2), ('mutton','Keema','500g',3),
  ('mutton','Chops','500g',4), ('mutton','Ribs','500g',5),
  ('fish','Fresh Fish','1kg',1), ('fish','Sea Fish','1kg',2), ('fish','Prawns','500g',3),
  ('fish','Crab','1kg',4), ('fish','Shellfish','500g',5),
  ('bakery','Bread','1 loaf',1), ('bakery','Cake','500g',2), ('bakery','Cookies','250g',3),
  ('bakery','Pastries','1pc',4), ('bakery','Buns','4pc',5),
  ('dairy','Milk','1L',1), ('dairy','Curd','500g',2), ('dairy','Butter','100g',3),
  ('dairy','Cheese','200g',4), ('dairy','Paneer','250g',5),
  ('medical','Medicines','1pc',1), ('medical','Baby Care','1pc',2), ('medical','Healthcare','1pc',3),
  ('medical','Personal Care','1pc',4), ('medical','First Aid Kit','1pc',5),
  ('stationery','Notebooks','1pc',1), ('stationery','Pens','1pc',2), ('stationery','Files','1pc',3),
  ('stationery','Office Supplies','1pc',4),
  ('hardware','Paint','1L',1), ('hardware','Electrical Items','1pc',2), ('hardware','Plumbing Items','1pc',3),
  ('hardware','Tools','1pc',4), ('hardware','Construction Materials','1pc',5),
  ('electronics','Chargers','1pc',1), ('electronics','Batteries','1pc',2), ('electronics','Adapters','1pc',3),
  ('electronics','Cables','1pc',4), ('electronics','Accessories','1pc',5),
  ('pet','Pet Food','1kg',1), ('pet','Pet Toys','1pc',2), ('pet','Pet Medicines','1pc',3),
  ('pet','Pet Accessories','1pc',4)
ON CONFLICT (category_id, name) DO NOTHING;

-- ── admin action log (audit trail starts now) ──────────────────────
CREATE TABLE IF NOT EXISTS shopbook_admin_log (
  id         BIGSERIAL PRIMARY KEY,
  action     TEXT        NOT NULL,
  target     TEXT        NOT NULL DEFAULT '',
  detail     JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
