## Purpose

A payment is a record of money that arrived, never a status somebody set. Payment state is derived from the payments themselves, so there is no column that can drift away from the money.

## ADDED Requirements

### Requirement: Invoice payment state is derived
The system SHALL derive an invoice's payment state (`unpaid`, `partially_paid`, `paid`) from the sum of its captured payments against its total, and SHALL NOT store a payment status that could disagree with them.

#### Scenario: Part payment
- **WHEN** captured payments total less than the invoice total and more than zero
- **THEN** the invoice reads `partially_paid`, with paid and due amounts reported

### Requirement: A payment posts its ledger entry atomically
The system SHALL write the payment row and its khata ledger entry in the same transaction.

#### Scenario: Payment recorded
- **WHEN** an owner records a payment
- **THEN** the customer's pending amount falls by the same amount in the same commit

### Requirement: Manual payments are the shop's assertion
The system SHALL treat a manually entered payment (cash, UPI, bank) as the shop asserting money in hand, and SHALL NOT confirm a payment on a customer client's word.

#### Scenario: Customer cannot self-confirm
- **WHEN** a customer client posts a payment for its own debt
- **THEN** the request is refused

### Requirement: Per-customer credit limit
The system SHALL support a credit limit per customer, where 0 means no ceiling. Account customers and walk-in customers SHALL each carry their limit in their own table and SHALL be compared against the same derived balance — a sum over the ledger, never a stored total.

A credit entry that would take the balance past a non-zero limit SHALL be held and reported to the owner with the current balance, the limit and the balance the entry would produce. It SHALL be a question, not a refusal: the owner may confirm it through, because they know the customer and the app does not. Confirming SHALL reuse the original idempotency key so the confirmation cannot post the entry twice.

#### Scenario: Limit exceeded
- **WHEN** a credit entry would take the balance past a non-zero limit
- **THEN** the entry is not posted and the breach is reported with the limit, the current balance and the resulting balance

#### Scenario: Owner confirms anyway
- **WHEN** the owner confirms a reported breach
- **THEN** the entry posts exactly once, on the same idempotency key

#### Scenario: No ceiling set
- **WHEN** the customer's limit is 0
- **THEN** no ceiling is enforced

#### Scenario: The owner can see the ceiling before changing it
- **WHEN** an owner opens a customer's ledger
- **THEN** the ceiling in force is shown, with 0 presented as "no limit"
