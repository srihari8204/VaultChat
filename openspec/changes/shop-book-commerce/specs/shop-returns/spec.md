## Purpose

Goods coming back is a new event with a new document. Editing the original invoice would make the shop's tax records indefensible and quietly rewrite what the customer was told they bought.

## ADDED Requirements

### Requirement: A finalized invoice is never edited
The system SHALL NOT modify the content of a finalized invoice when goods are returned. It SHALL issue a credit note that references the invoice and stands beside it.

#### Scenario: Approved return
- **WHEN** an owner approves a return
- **THEN** a credit note referencing the original invoice is issued and the invoice content is untouched

### Requirement: Refund value comes from the original line
The system SHALL compute refund value from the line price recorded at sale, never from the product's current price.

#### Scenario: Price rose since the sale
- **WHEN** the product's price increased between the sale and the return
- **THEN** the credit note still refunds the original line price

### Requirement: Return window
The system SHALL accept a return request only within 7 days of collection, and SHALL state the window in the refusal when it has passed.

#### Scenario: Late request
- **WHEN** a customer requests a return more than 7 days after collection
- **THEN** the request is refused with the window named

### Requirement: Owner decision
The system SHALL require the owner to approve or reject each return, with a reason on rejection. Approval SHALL post the khata credit entry and return sellable goods to stock in the same transaction.

#### Scenario: Rejection
- **WHEN** an owner rejects a return
- **THEN** a reason is required, no credit note is issued and stock is unchanged
