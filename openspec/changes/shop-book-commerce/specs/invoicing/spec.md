## Purpose

Country-rule-driven documents for every kind of sale a shop makes, not only the ones that arrived through the app.

## MODIFIED Requirements

### Requirement: Country-rule-driven invoice generation
The system SHALL generate an invoice for every completed order using the shop's country configuration, including: business details, invoice number, customer details, product lines, tax details (only when configured), and payment status.

A document SHALL carry one of four sources — `order`, `khata`, `counter`, `receipt` — held in one table, and SHALL NOT be produced by synthesising a fake order.

For the three non-order sources the document SHALL restate the total the khata already posted: subtotal equals total, tax total is zero, and per-item tax rates SHALL NOT be printed. A true tax invoice for those sources requires the order path's tax engine.

A finalized invoice's content SHALL be immutable; only its lifecycle status (`cancelled`, `credited`) may change.

#### Scenario: GST invoice for a registered Indian shop
- **WHEN** a completed order belongs to an Indian shop with GSTIN configured
- **THEN** the invoice shows GSTIN, per-line HSN/tax rate where set, CGST/SGST (or IGST) breakdown, and totals in ₹ using the India layout

#### Scenario: Invoice without tax configuration
- **WHEN** a shop has no tax fields configured
- **THEN** the invoice omits all tax sections and shows only business, customer, product, and payment details

#### Scenario: Khata invoice restates the ledger
- **WHEN** an owner issues an invoice for a khata entry
- **THEN** its total equals the entry's amount, tax total is zero, and no per-item tax rate is shown

#### Scenario: Attempt to edit a finalized invoice
- **WHEN** any field other than status is updated on a finalized invoice
- **THEN** the write is refused

## ADDED Requirements

### Requirement: Tax invoice versus retail invoice
The system SHALL let a buyer supply a tax number (with business name and address) against an order before it settles, and SHALL choose the document shape from whether one was supplied: with a tax number, a tax invoice carrying both parties' tax numbers, per-item HSN/SAC and tax split by rate; without one, a retail invoice showing totals only. The buyer tax number SHALL remain optional throughout.

#### Scenario: Business buyer
- **WHEN** a buyer supplies a tax number before the order settles
- **THEN** the issued document is a tax invoice carrying both tax numbers and the per-rate tax split

#### Scenario: Walk-in buyer
- **WHEN** no buyer tax number is supplied
- **THEN** the issued document is a retail invoice with no blank statutory fields
