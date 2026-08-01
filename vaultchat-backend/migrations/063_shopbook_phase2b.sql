-- 063_shopbook_phase2b.sql — SHOP BOOK Phase 2b. Idempotent.
--
-- Free/Pro plan flag (manual upgrade — no payment gateway) and richer shop
-- timings (lunch break window; weekly holiday already exists). Delivery stays
-- in the schema from 062 but is no longer surfaced in the app UI.

ALTER TABLE shopbook_shop ADD COLUMN IF NOT EXISTS plan        TEXT NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free','pro'));
ALTER TABLE shopbook_shop ADD COLUMN IF NOT EXISTS lunch_start TEXT NOT NULL DEFAULT '';  -- HH:MM, '' = none
ALTER TABLE shopbook_shop ADD COLUMN IF NOT EXISTS lunch_end   TEXT NOT NULL DEFAULT '';
