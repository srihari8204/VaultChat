-- 097_shopbook_verification.sql — SHOP BOOK verification, documents and
-- controlled location changes (P1-D). Idempotent.
--
-- 094 gave the shop a verify_state. This gives it the things that state is
-- supposed to be decided FROM, and closes the one field a shop could quietly
-- move after being approved.
--
-- Documents are stored the way every other private file in VaultChat is: an
-- object key, never bytes in a row. They are business records — a shop
-- licence, a tax certificate — so they must never be reachable from the public
-- shop-discovery surface, and the key alone is not an access grant.

-- ── shop identity: the photos registration asks for ───────────────
ALTER TABLE shopbook_shop
  ADD COLUMN IF NOT EXISTS front_photo_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS logo_key        TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS interior_keys   JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS email           TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS description     TEXT NOT NULL DEFAULT '',
  -- Why a shop was rejected or suspended. Without it, "rejected" is a dead end
  -- the owner cannot act on, and support has to guess too.
  ADD COLUMN IF NOT EXISTS verify_note     TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS verified_at     TIMESTAMPTZ,
  -- The GPS fix captured at registration. Kept separate from lat/lng so a
  -- later move is visible as a move rather than overwriting the origin.
  ADD COLUMN IF NOT EXISTS origin_lat      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS origin_lng      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing shops keep their current position as their origin, so nothing reads
-- as having moved just because the column appeared.
UPDATE shopbook_shop
   SET origin_lat = lat, origin_lng = lng
 WHERE origin_lat IS NULL AND lat IS NOT NULL;

-- A verified shop's location is pinned. Customers walk to these coordinates;
-- silently changing them after a verification badge is granted is how a
-- verified listing ends up pointing somewhere else entirely.
UPDATE shopbook_shop SET location_locked = TRUE WHERE verify_state = 'verified';

-- ── verification documents ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopbook_document (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL,           -- from the country config's documents[]
  object_key  TEXT        NOT NULL,           -- storage key; NOT a URL, NOT a grant
  filename    TEXT        NOT NULL DEFAULT '',
  mime        TEXT        NOT NULL DEFAULT '',
  size_bytes  BIGINT      NOT NULL DEFAULT 0,
  status      TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','rejected')),
  review_note TEXT        NOT NULL DEFAULT '',
  uploaded_by UUID        REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shopbook_document_shop
  ON shopbook_document(shop_id, uploaded_at DESC);
-- One live document per kind per shop; re-uploading replaces rather than
-- accumulating twelve copies of the same licence for an admin to wade through.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_document_kind
  ON shopbook_document(shop_id, kind) WHERE status <> 'rejected';

-- ── location change requests ──────────────────────────────────────
-- A locked shop asks; an admin decides. The request carries both positions so
-- the review is a comparison rather than an act of faith.
CREATE TABLE IF NOT EXISTS shopbook_location_request (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      UUID        NOT NULL REFERENCES shopbook_shop(id) ON DELETE CASCADE,
  from_lat     DOUBLE PRECISION,
  from_lng     DOUBLE PRECISION,
  from_address TEXT        NOT NULL DEFAULT '',
  to_lat       DOUBLE PRECISION NOT NULL,
  to_lng       DOUBLE PRECISION NOT NULL,
  to_address   TEXT        NOT NULL DEFAULT '',
  distance_km  DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason       TEXT        NOT NULL DEFAULT '',
  status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected')),
  review_note  TEXT        NOT NULL DEFAULT '',
  requested_by UUID        REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_shopbook_location_request
  ON shopbook_location_request(status, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopbook_location_request_one_open
  ON shopbook_location_request(shop_id) WHERE status = 'pending';

-- ── P2: the indexes the query plans have been missing ─────────────
-- Product search is ILIKE '%term%' across every approved shop, which no
-- b-tree can serve. Trigram makes it an index scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_shopbook_product_name_trgm
  ON shopbook_product USING gin (name gin_trgm_ops);

-- Nearby search filters on approved shops with coordinates; the plain
-- (lat,lng) index from 061 cannot skip the unapproved ones.
CREATE INDEX IF NOT EXISTS idx_shopbook_shop_geo_approved
  ON shopbook_shop(lat, lng) WHERE approved AND lat IS NOT NULL AND lng IS NOT NULL;

-- Every khata read groups by (shop, customer) over type; every dashboard sums
-- the same rows. 061's index leads with created_at, which neither needs.
CREATE INDEX IF NOT EXISTS idx_shopbook_ledger_balance
  ON shopbook_ledger(shop_id, customer_user_id, type);

-- Owner order lists filter by status and page by recency.
CREATE INDEX IF NOT EXISTS idx_shopbook_order_shop_status
  ON shopbook_order(shop_id, status, created_at DESC);
