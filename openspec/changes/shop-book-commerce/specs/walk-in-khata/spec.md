## Purpose

The neighbour who buys on credit and will never install the app. A walk-in is the shopkeeper's own address book entry — it belongs to the shop, not to the platform, and creates no user account.

## ADDED Requirements

### Requirement: Walk-in customers belong to the shop
The system SHALL let an owner create a khata customer with a name and mobile, scoped to the owner's shop, and SHALL NOT create or modify any `users` row for one. The shop SHALL be taken from the authenticated owner, never from the request body.

#### Scenario: Duplicate by mobile
- **WHEN** an owner creates a khata customer whose mobile already exists in that shop
- **THEN** the existing customer is returned rather than a second row created

### Requirement: Walk-in records are create-only
The system SHALL NOT expose update or delete for a khata customer, and the database SHALL restrict deletion of one that has ledger history.

#### Scenario: Deletion attempted
- **WHEN** deletion of a khata customer with ledger entries is attempted
- **THEN** it is refused

### Requirement: A ledger entry has exactly one party
The system SHALL record each ledger entry against either an account customer or a walk-in customer, never both and never neither.

#### Scenario: Both parties supplied
- **WHEN** an entry names both an account customer and a walk-in customer
- **THEN** it is rejected

### Requirement: Walk-ins count toward the plan limit
The system SHALL count distinct walk-in customers alongside distinct account customers when enforcing the Free plan's customer cap.

#### Scenario: Many walk-ins on a Free plan
- **WHEN** a Free-plan shop has walk-in customers
- **THEN** each distinct walk-in counts as one customer against the cap

### Requirement: Walk-in authorisation is by ownership
The system SHALL authorise a walk-in ledger entry by the customer row belonging to the owner's shop, and SHALL NOT apply the account-customer rule that requires a prior transaction.

#### Scenario: First entry for a new walk-in
- **WHEN** an owner posts the first ledger entry for a walk-in they just created
- **THEN** it is accepted

### Requirement: Counter sale
The system SHALL let an owner record an over-the-counter sale with line items and an optional buyer name and phone, producing a document without creating a customer identity or any debt.

#### Scenario: Cash sale to a stranger
- **WHEN** an owner records a counter sale
- **THEN** a `counter` document is issued and no ledger balance is created
