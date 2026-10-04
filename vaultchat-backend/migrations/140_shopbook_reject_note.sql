-- 140_shopbook_reject_note.sql — the owner's own words when rejecting an order as "Other".
--
-- NOT APPLIED ANYWHERE. Written 2026-10-04; scratch-DB only.
--
-- reject_reason (069) holds one of six codes, and "other" told the customer
-- nothing. POST /shopbook/my-shop/orders/{id}/status now accepts an optional
-- `note` with reason "other"; it is stored here and returned as `rejectNote` in
-- the order view (orderWithItems). Same NOT NULL DEFAULT '' shape as the other
-- reason columns, so existing rows and readers are unaffected.
--
-- The CHECK mirrors sbRejectNoteMax (200) in internal/routes/shopbook.go; the
-- handler refuses longer notes with 400 note_too_long before they reach here.
--
-- Additive and instant (a constant default, no table rewrite on PG 11+).
-- Reverse: ALTER TABLE shopbook_order DROP COLUMN IF EXISTS reject_note;

ALTER TABLE shopbook_order
  ADD COLUMN IF NOT EXISTS reject_note TEXT NOT NULL DEFAULT ''
  CONSTRAINT shopbook_order_reject_note_len CHECK (char_length(reject_note) <= 200);
