## Purpose

Two trails, deliberately separate: what happened inside a shop, which its owner may read, and what the platform did to a shop, which only admins write.

## ADDED Requirements

### Requirement: Shop-scoped audit trail
The system SHALL record shop-scoped actions — ledger adjustments, stock adjustments, purchases, returns, plan and profile changes — with actor, action and time, and SHALL expose the trail to the shop owner.

#### Scenario: Ledger adjustment
- **WHEN** an owner posts or adjusts a khata entry
- **THEN** an audit row naming the actor and the change is written

### Requirement: Audit writes never block the business action
The system SHALL treat an audit write as best-effort — a failure SHALL NOT fail the action being recorded — and SHALL log the failure loudly.

#### Scenario: Audit insert fails
- **WHEN** the audit write errors
- **THEN** the business action still commits and the failure is logged

### Requirement: The trail outlives its actors, not its shop
The system SHALL refuse every UPDATE and every direct DELETE against the shop-scoped trail, and SHALL allow its rows to be removed only as part of deleting the shop they belong to.

#### Scenario: An actor tries to erase a line
- **WHEN** a DELETE is issued against the audit trail
- **THEN** it is refused, as an edit would be — for a log, removing a line and rewriting it are the same attack

#### Scenario: The shop is deleted
- **WHEN** a shop with audit rows is deleted
- **THEN** the deletion succeeds and its audit rows go with it

### Requirement: Platform admin trail
The system SHALL record every admin mutation — approval, verification, entitlement grant, location decision, config edit — to a platform trail distinct from the shop-scoped one.

#### Scenario: Admin approves a shop
- **WHEN** an admin approves a shop
- **THEN** the platform trail records who did it and when
