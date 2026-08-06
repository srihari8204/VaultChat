## MODIFIED Requirements

### Requirement: Invoice access
The system SHALL make each invoice available to both the customer (in invoice history) and the owner (in the ledger and reports), in a shareable format. The customer-facing presentation SHALL be a consumer retail receipt as specified below; the owner's record SHALL retain the full tax detail.

#### Scenario: Customer retrieves an invoice
- **WHEN** a customer opens an entry in invoice history
- **THEN** the retail receipt is viewable and shareable

#### Scenario: Owner record keeps full detail
- **WHEN** the owner views the same invoice or runs a tax report
- **THEN** the stored tax type, per-component breakdown, and configured tax identifiers are still available

## ADDED Requirements

### Requirement: Consumer retail receipt format
The customer-facing receipt SHALL present retail, tax-inclusive prices. It SHALL show the shop name and address, order identifier, date, customer name, itemised lines with their retail prices, any discount, the amount paid, and payment status. It SHALL NOT show the shop's business tax identifiers.

#### Scenario: Tax-registered shop receipt
- **WHEN** a customer opens the receipt for an order from a shop that has configured tax details
- **THEN** the line prices and total are tax-inclusive, a single "Inclusive of all taxes" line states the included tax amount, and no GSTIN, VAT number, or other business tax identifier appears

#### Scenario: Shop with no tax configuration
- **WHEN** a customer opens the receipt for an order from a shop with no tax details configured
- **THEN** the receipt shows items and total with no tax line at all

#### Scenario: Currency and date follow the shop's country
- **WHEN** a receipt is rendered for a shop in any supported country
- **THEN** its currency symbol and date format come from that shop's country configuration, and the customer is never asked for country or tax information

#### Scenario: Discount is shown as savings
- **WHEN** an order carried a discount
- **THEN** the receipt shows the amount saved alongside the total
