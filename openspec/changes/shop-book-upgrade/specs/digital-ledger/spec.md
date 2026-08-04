## Purpose

Replaces the paper khata: every completed purchase and payment is recorded automatically, and both the customer and the shop owner see the same purchase, paid, and pending amounts at all times.

## ADDED Requirements

### Requirement: Automatic purchase recording
The system SHALL record every completed order in the ledger automatically, updating the customer's purchase amount, paid amount, and pending amount for that shop. Ledger history SHALL be permanent and unlimited for customers.

#### Scenario: Purchase recorded on completion
- **WHEN** an order is marked Completed
- **THEN** a ledger entry is created with the order amount, linked invoice, and the shop's running balance for that customer updates

#### Scenario: Partial payment
- **WHEN** the owner records a payment smaller than the outstanding balance
- **THEN** the paid amount increases, the pending amount decreases accordingly, and the transaction appears in both parties' history

### Requirement: Shared ledger visibility
The system SHALL show the same ledger state to both parties: the customer sees per-shop purchase totals, payments, pending amount, transaction history, and invoice history; the owner sees the equivalent per-customer view with shop-wide pending totals.

#### Scenario: Customer checks dues
- **WHEN** a customer opens a shop's ledger
- **THEN** they see total purchases, total paid, current pending amount, and a dated transaction list matching the owner's records

#### Scenario: Owner pending collections
- **WHEN** an owner opens the ledger overview
- **THEN** customers with pending amounts are listed with balances and last-transaction dates

### Requirement: Payment recording
The system SHALL let the owner record payments received (full or partial) against a customer's balance, and SHALL notify the customer when a payment is recorded.

#### Scenario: Payment received notification
- **WHEN** the owner records a payment from a customer
- **THEN** the customer receives a payment-received notification and their pending amount updates
