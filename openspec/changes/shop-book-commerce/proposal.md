## Why

`shop-book-upgrade` is archived and its fourteen capabilities are now the Shop
Book baseline. They describe roughly forty percent of what is actually running:
between migrations 092 and 112 the product grew inventory, purchasing, returns,
payments, live billing, verification, walk-in khata, engagement, an audit trail
and API limits — ninety-six routes in twenty-four Go files — none of which any
spec mentions. An unspecced capability cannot be reviewed, cannot be regression-
checked, and cannot tell a future change what it is allowed to break.

This change writes the specs for what shipped, and closes the four places where
the backend shipped without a way to reach it.

## What Changes

- **Retro-spec ten built capabilities.** No behaviour change: these requirements
  describe code that is deployed and, for the money paths, already carrying real
  shop data.
- **Wire four unreachable features.** `setBuyerTax`, `counterSale`,
  `setCreditLimit` / `setKhataCreditLimit` and `requestLocationChange` exist in
  `services/shopBookService.ts` with **no call site anywhere in the app**. The
  endpoints are live on production. Consequences today: a business buyer can
  never supply a tax number, so the claimable tax invoice (the 2026-08-10
  addendum B differentiator) is unreachable; a cash counter sale has no screen;
  every credit limit is structurally 0 = unlimited, because nothing can write
  the column migration 112 added; and a verified shop can never move, because
  the admin decide-route has nobody to decide about.
- **Settle the price-comparison staleness policy** left open by addendum D:
  no owner opt-out, and a price older than the freshness window is labelled
  rather than hidden or silently presented as current.
- **Give the money paths one behavioural check.** Every existing shopbook test
  is structural or pure-function; no test has ever written a khata row against a
  real schema. One SQL test in the established `migrations/tests/` pattern.
- **Fix the localization leak**: `toLocaleDateString('en-IN')` is hardcoded in
  the client while `localization` requires the country config to supply formats.

## Capabilities

### New Capabilities
- `shop-inventory`: opt-in per-product stock tracking, the conditional-UPDATE
  reservation that makes concurrent orders safe, and the movement ledger.
- `shop-purchasing`: purchases, suppliers, cost-at-sale and the margin figures
  that depend on them.
- `shop-returns`: customer return requests, owner decision, credit notes, and
  the rule that a finalized invoice is never edited.
- `shop-payments`: recorded payments, derived invoice payment state, and
  per-customer credit limits for both party kinds.
- `shop-billing`: the preparing/packing billing window, server-side pricing,
  coupons, delivery fee, round-off.
- `shop-verification`: verification submission, private documents via presigned
  URLs, and the pinned location of a verified shop.
- `walk-in-khata`: shop-owned customers with no VaultChat account, counter
  sales, and khata receipts.
- `shop-engagement`: order ratings, loyalty points, favorites, coupon listing.
- `shop-audit-log`: the shop-scoped trail an owner reads and the platform trail
  an admin writes.
- `shop-api-limits`: keyset pagination and fail-open rate limiting on the
  expensive endpoints.

### Modified Capabilities
- `invoicing`: four document sources (`order` | `khata` | `counter` | `receipt`),
  the buyer tax number that splits a sale into a tax invoice or a retail
  invoice, and the rule that non-order documents restate the khata total and
  compute no tax.
- `digital-ledger`: real line items, the audit stamp on every khata write, and
  the second party kind (walk-in) with exactly one of the two set.
- `price-comparison`: the staleness policy.
- `subscription-plans`: the entitlement record — not the `plan` column — is the
  authority for what a shop may use.
- `admin-portal`: verification review, document inspection, location decisions
  and entitlement grants, and the rule that an admin never edits a shop's money.

## Impact

- **Client**: four owner-side forms in `app/shop-book.tsx` (buyer tax on an
  order, counter sale, credit limit on a customer row, location change request),
  a staleness label in the comparison list, and country-driven date formatting.
  No new screens beyond these; all four services already exist.
- **Backend**: none. Every endpoint these forms call is deployed.
- **Database**: none. Migrations 092–112 are already applied on production
  (`schema_migrations` max 112).
- **Tests**: one `migrations/tests/` SQL file exercising a khata write, its
  credit ceiling and its audit row against a copy of the real schema.
- **Carried over**: `shop-book-upgrade` task 8.9 (delete the
  `SHOPBOOK_OWNER_COLLECT` grace branch) stays open here — it is blocked on the
  updated client actually reaching the field, not on code.
