## Purpose

Lets a shop count what it actually holds, and stops two customers being sold the same last bag of rice. Tracking is opt-in per product, because a shop selling vegetables by the handful must not be forced to count.

## ADDED Requirements

### Requirement: Opt-in stock tracking
The system SHALL track stock only for products whose `track_stock` flag is set. An untracked product SHALL continue to report availability from the owner-set `in_stock` boolean.

#### Scenario: Untracked product is unaffected
- **WHEN** a product has stock tracking off
- **THEN** its availability comes from `in_stock` and no stock row is required

#### Scenario: Tracked product reports available quantity
- **WHEN** a product has stock tracking on
- **THEN** its availability is `on_hand - reserved > 0`

### Requirement: Reservation is decided by the database
The system SHALL reserve stock with a single conditional UPDATE guarded by `on_hand - reserved >= quantity`. Any availability check made before that statement is advisory only, and SHALL NOT be treated as a guarantee.

#### Scenario: Concurrent orders for the last unit
- **WHEN** two orders for the last unit of a tracked product are placed at the same time
- **THEN** exactly one reservation succeeds and the other is refused as unavailable

### Requirement: Stock movement ledger
The system SHALL record every stock change as a signed movement with its reason (sale, purchase, adjustment, return), and SHALL expose the movement history for a product to the owner.

#### Scenario: Owner inspects a product's history
- **WHEN** the owner opens a tracked product's stock history
- **THEN** the movements are listed newest first with delta, reason and time

### Requirement: Quantities are exact
The system SHALL represent quantities as integer hundredths, matching order-item quantity, and SHALL NOT use floating point for any stock arithmetic.

#### Scenario: Fractional weight
- **WHEN** 1.18 kg is recorded
- **THEN** it is stored as 118 hundredths
