# order-management Specification

## Purpose
Defines the pickup-order lifecycle end to end: cart, placement, owner availability review with alternatives, the status pipeline through collection, and the cancellation/rejection rules both sides can rely on.
## Requirements
### Requirement: Shopping cart
The system SHALL maintain a per-shop cart showing product, quantity, brand, unit, price, notes, and total. Custom (manually typed) items SHALL appear in the cart without a price until the owner confirms one.

#### Scenario: Cart review
- **WHEN** a customer opens the cart
- **THEN** every line shows product, quantity, brand, unit, price, and notes, with an order total for priced items

### Requirement: Order placement and status pipeline
The system SHALL move each order through the statuses: Pending → Accepted → Preparing → Packing → Ready → Collected → Completed, with terminal alternatives Rejected and Cancelled. Every transition SHALL be timestamped and visible to the customer as an order timeline.

#### Scenario: Order placed
- **WHEN** a customer places an order
- **THEN** the order is created in Pending, the owner is notified, and the customer sees the order in tracking

#### Scenario: Progress tracking
- **WHEN** the owner advances the order (Accepted, Preparing, Packing, Ready)
- **THEN** the customer's tracking screen updates in near-real time with each timestamped step

#### Scenario: Collection and completion
- **WHEN** the customer collects the order and the owner marks it Collected
- **THEN** the order completes, the purchase is recorded in the digital ledger, and an invoice is generated

### Requirement: Availability review with alternatives
The system SHALL require the owner to review each order item and mark it Available, Alternative Available (with a suggested substitute), or Unavailable. The customer SHALL be notified and SHALL be able to accept the alternative, reject it, or remove the item, then continue the order.

#### Scenario: Alternative suggested and accepted
- **WHEN** the owner marks an item Alternative Available with a substitute product/brand and price
- **THEN** the customer is notified, and on acceptance the order line is replaced with the alternative and the total is updated

#### Scenario: Alternative rejected
- **WHEN** the customer rejects a suggested alternative
- **THEN** the item is removed from the order and the remaining items proceed

#### Scenario: All items unavailable
- **WHEN** every item in an order is Unavailable or removed
- **THEN** the order is rejected as Out of Stock and the customer is notified immediately

### Requirement: Cancellation rules
The system SHALL allow the customer to cancel an order only before the owner accepts it, and the owner to cancel only before packing begins. A cancellation reason SHALL be required in both cases.

#### Scenario: Customer cancels in time
- **WHEN** a customer cancels a Pending order and provides a reason
- **THEN** the order becomes Cancelled and the owner is notified

#### Scenario: Customer cancels too late
- **WHEN** a customer attempts to cancel an order that is already Accepted
- **THEN** the cancellation is refused and the customer is directed to contact the shop

#### Scenario: Owner cancels before packing
- **WHEN** an owner cancels an Accepted or Preparing order with a reason
- **THEN** the order becomes Cancelled and the customer is notified immediately

### Requirement: Order rejection with reason
The system SHALL let the owner reject an order with one of: Out of Stock, Shop Closed, Quantity Not Available, Outside Business Hours, Technical Issue, or Other (with free text). The customer SHALL be notified immediately with the reason.

#### Scenario: Rejection notice
- **WHEN** an owner rejects a Pending order selecting a reason
- **THEN** the order becomes Rejected and the customer receives a notification carrying the reason

