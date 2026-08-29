# Design — shop-book-commerce

## Context

Two thirds of this change is retro-documentation: migrations 092–112 and 24 Go
files are on production and carrying real shop data. The specs here describe
what the code already does, verified against the source, not what someone
intended. Where a spec and the code disagree, the code is the bug — except in
the four places listed under **Unreachable features**, where the code is right
and there is simply no way to reach it.

## Decisions

### D1 — Retro-spec rather than re-derive

The alternative was to write specs from the original Shop Book design documents
and then reconcile. That produces a spec describing a product nobody shipped.
Every requirement below was written from the Go source and its header comments,
which in this codebase carry the reasoning (`shopbook_money.go` on floats,
`shopbook_return.go` on never editing a finalized invoice).

### D2 — Wire the four dead services; add no backend

`setBuyerTax`, `counterSale`, `setCreditLimit`/`setKhataCreditLimit` and
`requestLocationChange` are already in `services/shopBookService.ts` and their
endpoints already answer on production. The whole cost is four owner-side forms
in `app/shop-book.tsx`. No migration, no handler, no deploy of the backend.

This matters more than it sounds:

- **Buyer tax number** is addendum B — the claimable tax invoice. Without the
  form, a business buyer can never reclaim tax, which is the single reason a
  shop's business customers would prefer this app to a paper bill.
- **Credit limits** are walk-in khata Gate 3. Migration 112 added the column
  with `DEFAULT 0` meaning "no ceiling"; nothing can write it, so every limit in
  production is 0. The policy is documented as enforced and is in fact inert.
- **Counter sale** is the cash-over-the-counter path. It shipped 2026-08-18 with
  a renderer and a document source of its own and has never had a screen.
- **Location request** is the other half of the pinned-location rule. The admin
  decide-route exists; nothing can create a request for it to decide.

### D3 — Price comparison: no opt-out, label staleness

Addendum D asked for two decisions before implementation. Taken here.

**No opt-out.** A comparison some shops can hide from is not a comparison, and
to the customer "hidden" and "does not stock it" look identical, which is worse
for the shop than an honest higher price. The remedy for being undercut is to
update the price — which is also what keeps the data fresh.

**Label, do not hide, stale prices.** Hiding a price older than the window makes
a shop that stocks the item look like one that does not. Showing it unmarked is
how a customer walks to a shop for a price that expired a fortnight ago. So: a
`stale` marker beside the existing last-updated date, at 14 days.

14 days, not 7: staple prices in a kirana shop genuinely do not move weekly, and
a window that marks half the catalog stale teaches customers to ignore the
marker. Client-side, from the `updatedAt` the search already returns — no schema,
no backend, and the threshold can move without a deploy of either.

### D4 — One behavioural money test, in the existing SQL pattern

Every shopbook test today is structural (reads source) or pure-function. No test
has ever written a khata row against a real schema, and the khata is where a
missing `WHERE shop_id` costs a shop its privacy and a customer their money.

The lazy check that actually fails when the logic breaks is a SQL test in the
established `migrations/tests/` pattern (`083_not_collected_test.sql`,
`110_documents_test.sql`): run against a throwaway copy of the schema, in a
transaction, rolled back. No framework, no fixtures, no test database to keep.

### D5 — Task 8.9 stays open, deliberately

`SHOPBOOK_OWNER_COLLECT` still defaults to the grace branch, which lets an owner
settle an order the customer never confirmed collecting — exactly what the
actor split exists to prevent. It cannot be removed here: the client carrying
the customer-side "I collected this" action has been built but never installed
on either test phone, so denying owner-collect today would strand every order in
the field at `ready`. It is carried forward as a task with its precondition
named, not silently dropped in the archive.

## Risks

- **Retro-specs can encode a bug as a requirement.** Mitigated by writing from
  source rather than from memory, and by keeping each requirement to behaviour
  that is visible at an endpoint.
- **The money paths remain plaintext with RLS inert** (`docs/RLS_ENFORCEMENT.md`,
  the API connects as a superuser). Nothing here changes that; every handler
  must keep scoping in SQL. The new specs say so where it bites — walk-in
  authorisation by ownership, documents never served by the API.
