# price-comparison Specification

## Purpose
Lets a customer compare what nearby shops charge for the same product before deciding where to order, using each shop's live catalog data.
## Requirements
### Requirement: Cross-shop price comparison
The system SHALL, for a searched product, list nearby shops offering it with: shop name, distance, price, stock availability, and the time the price was last updated.

#### Scenario: Compare a product
- **WHEN** a customer searches a product in price comparison
- **THEN** nearby approved shops with a matching catalog item are listed with the fields above

#### Scenario: Stale price indication
- **WHEN** a shop's price for the product has not been updated recently
- **THEN** the last-updated time is shown so the customer can judge freshness

### Requirement: Comparison sorting
The system SHALL sort comparison results by Lowest Price, Nearest Shop, or Open Now, selectable by the customer.

#### Scenario: Sort by lowest price
- **WHEN** the customer selects Lowest Price
- **THEN** results reorder by ascending price, ties broken by distance

#### Scenario: Sort by open now
- **WHEN** the customer selects Open Now
- **THEN** currently open shops rank above closed ones, each group ordered by distance

