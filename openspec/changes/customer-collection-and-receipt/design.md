## Context

See `proposal.md` — Why. Shop Book's order settlement already lives in one place: `sbSettleOrder` in `vaultchat-backend-go/internal/routes/shopbook.go` posts the khata purchase, stamps loyalty points and calls `sbCreateInvoice`, all inside the owner's status-transition transaction and all guarded to run exactly once per order. The invoice snapshot written by `sbCreateInvoice` (`shopbook_tax.go`) already stores everything a receipt needs, including `taxTotal` and the per-component `taxBreakdown`.

## Goals / Non-Goals

**Goals:**
- Reuse `sbSettleOrder` verbatim for the customer path so both parties' collection produces byte-identical settlement.
- Keep the stored invoice untouched — this is a presentation change plus one new entry point.
- Make the receipt readable to someone who has never seen a tax invoice.

**Non-Goals:**
- Changing how tax is computed, stored, or reported.
- A separate receipt document or table — the receipt is a rendering of the existing invoice.
- Delivery/courier receipt semantics; Shop Book v1 is pickup-first.

## Decisions

**D1 — Customer collection is a distinct endpoint, not a status parameter on the owner route.**
`POST /shopbook/orders/{id}/collected` is scoped by `customer_user_id` exactly as the existing customer-cancel route is, rather than widening the owner's `/my-shop/orders/{id}/status` route to accept customer callers. The owner route resolves the caller's shop first (`ownerShopID`) and would have to grow a second authorization mode; a separate route keeps each handler with one trust model. Alternative — a shared handler branching on role — rejected as the kind of conditional that leaks authorization bugs.

**D2 — Only `ready → collected` for customers.**
The customer transition is deliberately narrower than the owner's (`sbOwnerNext` also allows `ready → completed` and `collected → completed`). A customer confirming before the shop says Ready would settle an order that was never handed over. Attempting it returns a conflict, not a silent no-op.

**D3 — Idempotency comes from the existing guards, not a new one.**
`sbSettleOrder` already checks for an existing purchase ledger row, and `shopbook_invoice.order_id` is UNIQUE with `sbCreateInvoice` short-circuiting when a row exists. The customer handler therefore treats an already-collected order as success (returns the current status) instead of erroring — the double-confirmation scenario resolves to "nothing happens twice".

**D4 — `collected_by` column rather than inferring from the timeline.**
The order timeline records events but its `note` is free text; deriving the actor by parsing notes would be fragile. One additive `collected_by` column (`''|customer|owner`) mirrors the existing `cancelled_by` convention, so the two "who did this" fields read the same way.

**D5 — Tax is computed as contained within the price, fixing a live discrepancy.**
Shop Book catalog prices are shelf prices, but `sbCreateInvoice` computed tax as `P·r/100` and stored `invoice.total = order.total + taxTotal` — tax added *on top*. The khata, meanwhile, records `order.total`. So for any shop that set a tax percent, the invoice claimed a larger amount than the customer actually owed and than the cart had shown. Restyling the invoice as a receipt with a prominent "Total paid" would have put that contradiction in front of customers, so it is fixed here rather than carried forward: included tax is `P·r/(100+r)`, `invoice.total` is the amount charged, and `invoice.subtotal` becomes the taxable ex-tax value the owner's tax report aggregates. A discount scales the included tax proportionally. The arithmetic is extracted into `sbIncludedTax`/`sbTaxBreakdown` and unit-tested (`shopbook_tax_test.go`).

Issued invoices are immutable, so rows written before this fix keep their old totals; only shops that had configured a tax percent are affected, and the discrepancy stops at deploy.

**D5a — The receipt needs no new API.** `taxTotal`, `total`, `discount` and the line prices are already on the invoice payload, so the receipt is purely a rendering change. Payment status is read from the existing khata endpoint rather than assumed, so the receipt never claims "paid" against an outstanding balance.

**D6 — Business tax identifiers are filtered at render time, not dropped at write time.**
`business.tax` stays in the stored snapshot (the owner needs it; compliance may need it). The customer receipt simply does not render it. Removing it from storage would break the owner's record for orders issued after the change.

## Risks / Trade-offs

- [Customer confirms collection without actually collecting] → Accepted: the ledger entry it creates is a *purchase* (raising what the customer owes), so the incentive runs against abuse; the owner is notified immediately and the timeline names the customer as the confirming party.
- [Owner and customer confirm simultaneously] → Both paths run inside a transaction that re-reads the order `FOR UPDATE`; the second one finds the settlement already done and is a no-op (D3).
- [Hiding tax IDs could be wrong in a market that mandates them on consumer receipts] → The stored invoice retains them and the owner's PDF path is unchanged, so a market-specific consumer template can be reintroduced from config later without data loss.
- [Tax-inclusive vs tax-exclusive pricing differs by market] → v1 treats catalog prices as shelf/retail prices (true for the launch markets' grocery retail); the receipt states "inclusive of all taxes" rather than recomputing, so it can never contradict the amount charged.

## Migration Plan

1. Migration `070_shopbook_collected_by.sql` (idempotent, one additive column with a default) — safe with the running binary.
2. Deploy the Go backend (new endpoint, actor recorded).
3. Ship the client (receipt restyle + Confirm collection action). Older clients keep working: the owner path is unchanged and the receipt is rendered from fields that already exist.

Rollback: redeploy the previous binary; the column is inert and the customer endpoint simply disappears.
