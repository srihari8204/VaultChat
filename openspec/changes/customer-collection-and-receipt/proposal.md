## Why

Two gaps remain after the Shop Book upgrade shipped.

**Collection is owner-only.** Only the shop owner can mark an order Collected, which settles the khata and issues the invoice. In a real pickup shop the customer is the one standing at the counter — if the owner is busy serving the next person, the order sits at Ready and the customer's ledger and invoice never appear. The customer needs to be able to confirm "I've got my order".

**The invoice reads like a tax document, not a receipt.** The current invoice exposes the shop's tax identifiers and a per-component tax breakdown — correct for a business record, wrong for the person who just bought milk. Consumer platforms (Amazon, Blinkit, any retail counter) show retail prices with tax already inside the total and a single "inclusive of all taxes" line. Shop Book's customer app should look like that.

## What Changes

- **Customer-confirmed collection**: a customer may confirm collection of their own order once it is Ready. It settles exactly as owner-marked collection does — ledger purchase, invoice issue, auto-complete — and records who confirmed it on the order timeline. The owner is notified.
- **Collection is recorded with an actor**: every collected order stores whether the customer or the owner confirmed it, so the timeline and the owner's records stay honest.
- **B2C retail receipt format**: the customer-facing receipt shows retail (tax-inclusive) prices, the order total, and a single "Inclusive of all taxes" line with the included tax amount. Business tax identifiers (GSTIN, VAT number, EIN, …) are omitted from the customer receipt. The shop's country config still supplies currency and date format automatically — the customer is never asked for tax details.
- **Receipt content**: shop name and address, order ID, date, customer name and pickup/delivery address, itemised lines with retail prices, savings/discount when present, payment status, and a thank-you footer.
- **The owner's tax record is unchanged**: the stored invoice keeps its full snapshot (tax type, per-component breakdown, tax identifiers) for reports and compliance. Only the customer-facing presentation changes.

## Capabilities

### Modified Capabilities
- `order-management`: adds customer-confirmed collection with an actor recorded on the order; the existing owner path and settlement behavior are unchanged.
- `invoicing`: the customer-facing receipt becomes tax-inclusive B2C format without business tax identifiers; the stored invoice record and owner/tax reporting are unchanged.

## Impact

- **Backend**: one new customer endpoint for collection confirmation, reusing the existing settlement transaction; an actor column on the order; a notification to the owner. No new tables.
- **Client**: the invoice screen and its shareable PDF are restyled as a retail receipt; the customer's order tracking gains a "Confirm collection" action at Ready.
- **Migration**: one additive column with a default — backward compatible, old binaries unaffected.
