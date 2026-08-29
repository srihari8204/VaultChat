## Purpose

The paper khata, kept online, with the line items and the change history a paper one never had.

## MODIFIED Requirements

### Requirement: Automatic purchase recording
The system SHALL record every completed order in the ledger automatically, updating the customer's purchase amount, paid amount, and pending amount for that shop. Ledger history SHALL be permanent and unlimited for customers.

A ledger entry MAY carry real line items. When it does, the entry's amount SHALL be derived server-side from those lines as the sum of quantity × price, and any client-supplied total SHALL be ignored. The entry, its items and its audit record SHALL be written in one transaction.

Every khata write SHALL leave an audit record naming the actor and the change.

#### Scenario: Purchase recorded on completion
- **WHEN** an order is marked Completed
- **THEN** a ledger entry is created with the order amount, linked invoice, and the shop's running balance for that customer updates

#### Scenario: Partial payment
- **WHEN** the owner records a payment smaller than the outstanding balance
- **THEN** the paid amount increases, the pending amount decreases accordingly, and the transaction appears in both parties' history

#### Scenario: Line items decide the amount
- **WHEN** an owner posts a khata entry with line items and a mismatched total
- **THEN** the stored amount is the sum of quantity × price and the supplied total is ignored

#### Scenario: Khata write is audited
- **WHEN** any khata entry is written or adjusted
- **THEN** an audit row is recorded in the same transaction
