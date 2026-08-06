# invoicing Specification

## Purpose
Generates invoices that automatically follow the shop's country rules — layout, currency, and tax breakdown — so an Indian GST invoice and a UK VAT invoice come from the same engine without shop-side configuration beyond the tax fields they chose to provide.
## Requirements
### Requirement: Country-rule-driven invoice generation
The system SHALL generate an invoice for every completed order using the shop's country configuration, including: business details, invoice number, customer details, product lines, tax details (only when configured), and payment status.

#### Scenario: GST invoice for a registered Indian shop
- **WHEN** a completed order belongs to an Indian shop with GSTIN configured
- **THEN** the invoice shows GSTIN, per-line HSN/tax rate where set, CGST/SGST (or IGST) breakdown, and totals in ₹ using the India layout

#### Scenario: Invoice without tax configuration
- **WHEN** a shop has no tax fields configured
- **THEN** the invoice omits all tax sections and shows only business, customer, product, and payment details

### Requirement: Sequential invoice numbering
The system SHALL assign each shop's invoices unique, sequential numbers within that shop, and invoice records SHALL be immutable once issued.

#### Scenario: Invoice sequence
- **WHEN** a shop's next order completes
- **THEN** its invoice number follows the shop's previous invoice with no gaps or duplicates

#### Scenario: Correction handling
- **WHEN** an issued invoice needs correction
- **THEN** the original remains unchanged and a correcting entry references it

### Requirement: Invoice access
The system SHALL make each invoice available to both the customer (in invoice history) and the owner (in the ledger and reports), in a shareable format.

#### Scenario: Customer retrieves an invoice
- **WHEN** a customer opens an entry in invoice history
- **THEN** the full invoice is viewable and shareable

