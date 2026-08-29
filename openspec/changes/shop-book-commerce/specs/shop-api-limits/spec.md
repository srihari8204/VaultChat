## Purpose

A shop with two thousand orders could reach nine hundred of them, and the expensive cross-shop endpoints were open at whatever rate a client cared to ask.

## ADDED Requirements

### Requirement: Keyset pagination on list endpoints
The system SHALL page list endpoints by cursor rather than offset, SHALL bound the requested page size, and SHALL return a next-cursor when more rows exist.

#### Scenario: Oversized page requested
- **WHEN** a client asks for 10,000 rows
- **THEN** it receives the bounded page size and a next-cursor

#### Scenario: Row inserted mid-scroll
- **WHEN** a row is inserted while a client is paging
- **THEN** no already-seen row is repeated and no unseen row is skipped

### Requirement: Rate limiting fails open
The system SHALL rate-limit cross-shop product search and nearby discovery, and SHALL allow the request when the limiter's backing store is unavailable.

#### Scenario: Redis is down
- **WHEN** the rate limiter cannot reach its store
- **THEN** requests are served rather than refused
