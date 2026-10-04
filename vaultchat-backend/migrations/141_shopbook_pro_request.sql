-- 141_shopbook_pro_request.sql — record an owner's "request Pro" for admins.
--
-- NOT APPLIED ANYWHERE. Written 2026-10-04; scratch-DB only.
--
-- An owner cannot grant themselves Pro (POST /shopbook/my-shop/plan refuses
-- plan=pro, bug #8), and until now had no way to ask except "contact support".
-- POST /shopbook/my-shop/plan/request-pro stamps this column (first request
-- wins; asking again is a no-op). It GRANTS NOTHING: entitlement still comes
-- only from POST /api/admin/shopbook/shops/{id}/entitlement, which clears the
-- stamp. GET /api/admin/shopbook/subscriptions returns it as proRequestedAt and
-- lists requesting shops first.
--
-- Additive, nullable, instant. Reverse:
--   ALTER TABLE shopbook_shop DROP COLUMN IF EXISTS pro_requested_at;

ALTER TABLE shopbook_shop ADD COLUMN IF NOT EXISTS pro_requested_at TIMESTAMPTZ;
