## Purpose

A verified badge is a claim customers walk to. The documents behind it are private business records, and the pin they were granted against must not move silently.

## ADDED Requirements

### Requirement: Documents are never served by the API
The system SHALL upload verification documents directly to object storage via a presigned PUT, and SHALL return them only through a short-lived presigned GET issued after an ownership check. An object key SHALL NOT be treated as an authorisation.

#### Scenario: Another owner holds a key
- **WHEN** a shop owner requests a document belonging to a different shop
- **THEN** the request is refused, regardless of the key being correct

### Requirement: Verification submission and review
The system SHALL let an owner submit a shop for verification with its country's document checklist, and SHALL grant the verified badge only on admin review.

#### Scenario: Submission
- **WHEN** an owner submits for verification
- **THEN** the shop enters a pending-verification state visible to admins

### Requirement: A verified shop's location is pinned
The system SHALL allow a verified shop's pin to drift no more than 300 m without review. A larger move SHALL require a location-change request carrying the new position, address and reason, decided by an admin.

#### Scenario: Large move attempted directly
- **WHEN** a verified shop updates its coordinates more than 300 m away
- **THEN** the update is refused and a location-change request is required

#### Scenario: Owner requests a move
- **WHEN** an owner submits a location-change request
- **THEN** it is queued for admin decision and the live pin is unchanged until decided
