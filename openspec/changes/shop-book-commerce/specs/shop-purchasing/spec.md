## Purpose

The other half of a sale. Until stock could arrive with a price attached, profit was a number the app had no honest way to compute.

## ADDED Requirements

### Requirement: Purchase recording is atomic
The system SHALL, for each recorded purchase, write the purchase document, move the stock in, and update the product's cost within one transaction.

#### Scenario: A purchase is recorded
- **WHEN** the owner records a purchase with line items
- **THEN** the document, the stock movements and the updated costs are all committed together, or none of them are

### Requirement: Suppliers
The system SHALL let an owner create, list and delete suppliers, and attach a supplier to a purchase.

#### Scenario: Purchase from a known supplier
- **WHEN** the owner records a purchase against an existing supplier
- **THEN** the purchase is listed under that supplier

### Requirement: Cost at sale
The system SHALL snapshot the product's cost onto the order line at the time of sale, and SHALL derive margin from that snapshot rather than from the product's current cost.

#### Scenario: Cost changes after a sale
- **WHEN** a product's cost is updated after an order was sold
- **THEN** the completed order's margin is unchanged
