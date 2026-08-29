## Purpose

The reason a customer opens this app instead of phoning the shop — and the reason an owner may leave it after being undercut by a rupee. The policy below settles both questions the 2026-08-10 addendum left open.

## MODIFIED Requirements

### Requirement: Cross-shop price comparison
The system SHALL, for a searched product, list nearby shops offering it with: shop name, distance, price, stock availability, and the time the price was last updated.

Shops SHALL NOT be able to opt out of comparison. A listing some shops can hide from is not a comparison, and to a customer a hidden shop is indistinguishable from one that does not stock the item.

A price whose last update is older than the freshness window (14 days) SHALL be labelled as stale wherever it is shown, and SHALL NOT be presented as current. It SHALL NOT be hidden — an old price is still information, and suppressing it makes a stocked shop look empty.

#### Scenario: Compare a product
- **WHEN** a customer searches a product in price comparison
- **THEN** nearby approved shops with a matching catalog item are listed with the fields above

#### Scenario: Stale price indication
- **WHEN** a shop's price for the product was last updated more than 14 days ago
- **THEN** the row is marked stale alongside its last-updated date, and is still listed

#### Scenario: Owner asks to be excluded
- **WHEN** a shop wishes not to appear in comparison
- **THEN** no such setting exists; the shop's remedy is to update its price
