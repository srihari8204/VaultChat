## Purpose

Where an order becomes a bill: the shop weighs what it actually packed, adds or drops a line, gives a counter discount. Every one of those is a write followed by a server re-derive.

## ADDED Requirements

### Requirement: The server prices the order
The system SHALL resolve every order line against the shop's catalog server-side, SHALL ignore any price or total sent by a client, and SHALL report back which lines moved.

#### Scenario: Client sends a stale price
- **WHEN** a client places an order carrying prices that no longer match the catalog
- **THEN** the order is priced from the catalog and the changed lines are returned to the customer

### Requirement: The billing window
The system SHALL allow the bill to change only while the order is `preparing` or `packing`. Once the order is `ready` the total SHALL be fixed.

#### Scenario: Edit after ready
- **WHEN** an owner tries to change a line on an order that has reached `ready`
- **THEN** the change is refused

### Requirement: Money is exact
The system SHALL represent money as an integer count of minor units end to end, converting at the database boundary only, and SHALL NOT perform monetary arithmetic in floating point.

#### Scenario: Total is computed
- **WHEN** a bill is re-derived
- **THEN** every intermediate value is an integer of minor units

### Requirement: Coupons and adjustments
The system SHALL resolve a coupon code server-side against the shop's active coupons, and SHALL apply delivery fee, bill discount and round-off as separate, visible components of the total.

#### Scenario: Invalid coupon
- **WHEN** a client sends a coupon code that is not active for that shop
- **THEN** no discount is applied and the total is unchanged
