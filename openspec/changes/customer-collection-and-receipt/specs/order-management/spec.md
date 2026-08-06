## MODIFIED Requirements

### Requirement: Order placement and status pipeline
The system SHALL move each order through the statuses: Pending → Accepted → Preparing → Packing → Ready → Collected → Completed, with terminal alternatives Rejected and Cancelled. Every transition SHALL be timestamped and visible to the customer as an order timeline. Collection MAY be confirmed by either the shop owner or the customer, and the system SHALL record which party confirmed it.

#### Scenario: Order placed
- **WHEN** a customer places an order
- **THEN** the order is created in Pending, the owner is notified, and the customer sees the order in tracking

#### Scenario: Progress tracking
- **WHEN** the owner advances the order (Accepted, Preparing, Packing, Ready)
- **THEN** the customer's tracking screen updates in near-real time with each timestamped step

#### Scenario: Collection and completion
- **WHEN** either party confirms collection of a Ready order
- **THEN** the order completes, the purchase is recorded in the digital ledger, an invoice is generated, and the timeline shows who confirmed the collection

## ADDED Requirements

### Requirement: Customer-confirmed collection
The system SHALL let a customer confirm collection of their own order only while it is Ready. Confirmation SHALL settle the order identically to owner-marked collection — ledger purchase, invoice issue, and completion — and SHALL notify the shop owner.

#### Scenario: Customer confirms at the counter
- **WHEN** a customer confirms collection of their Ready order
- **THEN** the order becomes Collected then Completed, the purchase and invoice are created exactly once, and the owner receives a notification

#### Scenario: Too early to confirm
- **WHEN** a customer attempts to confirm collection of an order that has not reached Ready
- **THEN** the confirmation is refused and the order is unchanged

#### Scenario: Only the owning customer may confirm
- **WHEN** a user who did not place the order attempts to confirm its collection
- **THEN** the request is refused

#### Scenario: Double confirmation is harmless
- **WHEN** the customer confirms collection of an order the owner already marked Collected
- **THEN** no second ledger entry or invoice is created and the order remains Completed
