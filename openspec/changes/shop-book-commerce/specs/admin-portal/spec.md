## Purpose

Platform-side control of a shop's standing — and a hard line at the shop's money.

## MODIFIED Requirements

### Requirement: Shop approval and verification
The system SHALL let administrators review pending shop registrations and their verification documents, then approve (optionally granting a verified badge) or reject with a reason communicated to the owner.

Administrators SHALL also decide location-change requests by comparing the current and requested positions, grant or revoke subscription entitlements, and read platform-wide windows onto orders, payments and returns.

Administrators SHALL NOT be able to edit a shop's ledger, invoices or payments. Approving, verifying, entitling and moving a pin are decisions about a shop's standing; adjusting its money is not an administrative act and SHALL have no endpoint.

#### Scenario: Approve a shop
- **WHEN** an administrator approves a pending shop
- **THEN** the shop becomes discoverable to customers and the owner is notified

#### Scenario: Reject with reason
- **WHEN** an administrator rejects a registration
- **THEN** the owner is notified with the reason and may resubmit corrected details

#### Scenario: Location decision
- **WHEN** an administrator decides a location-change request
- **THEN** the shop's pin moves only on approval, and the decision is recorded in the platform trail

#### Scenario: No money endpoint
- **WHEN** an administrator attempts to adjust a shop's ledger
- **THEN** no such capability exists
