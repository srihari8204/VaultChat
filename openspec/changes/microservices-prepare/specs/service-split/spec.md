# Spec Delta

## Purpose

Lets one backend image start as core or as a single feature service, while the
app keeps one front door, one live connection and the same login, and a bug in
one service cannot reach another service's data.

## ADDED Requirements

### Requirement: One image starts as any set of services

The backend SHALL read a `SERVICES` setting naming which services a process
runs: `all`, or a comma-separated list drawn from `core`, `golive`, `family`,
`games`, `maps`, `shopbook` and `calls`. An unset or empty setting SHALL mean
`all`. A process SHALL serve only the paths and run only the background jobs of
the services it runs, and SHALL answer every other path with 404. `/health`,
`/ready`, `/livez`, `/build` and `/internal/metrics` SHALL be served in every
mode. A process SHALL refuse to start when `SERVICES` names an unknown service.

#### Scenario: Unset setting keeps today's behaviour

- **WHEN** the API starts without `SERVICES`
- **THEN** it serves every path and runs every background job it serves and runs today

#### Scenario: A single feature serves only its own paths

- **WHEN** the API starts with `SERVICES=golive`
- **THEN** `GET /golive/health` and the `/broadcasts` paths are served
- **AND** `GET /chats` answers 404
- **AND** only Go Live's background jobs run

#### Scenario: Family Space paths live under the chat router

- **WHEN** the API starts with `SERVICES=family`
- **THEN** the Family Space paths under `/chats/{id}/`, `/user/sos` and `/contacts/trusted` are served
- **AND** every other `/chats/{id}/` path answers 404

#### Scenario: Unknown service name

- **WHEN** the API starts with `SERVICES=golive,chat`
- **THEN** it exits with an error naming `chat` before serving any request

### Requirement: Live events from a feature service reach phones through core

A process that does not run `core` SHALL NOT hold phone connections. Its live
events SHALL be sent to core's `POST /internal/emit`, and core SHALL deliver
them on the phone's one CC-Wire connection.

#### Scenario: Go Live emits from its own process

- **WHEN** a process running only `golive` emits an event to a user
- **THEN** it posts the event to core's `/internal/emit` with its internal key
- **AND** the user's connected devices receive it over CC-Wire

### Requirement: Every background job runs once per tick across copies

Each background job SHALL run only if it acquires a database lock named for
that job, held for the duration of the run. A copy of a service that cannot
acquire the lock SHALL skip that tick without error.

#### Scenario: Two copies tick together

- **WHEN** two copies of the same service fire the same job at the same time
- **THEN** exactly one of them runs the job and the other skips that tick

### Requirement: Core signs logins and every service verifies them

When an Ed25519 signing key is configured, core SHALL sign access tokens with
it (algorithm `EdDSA`), and every process SHALL verify access tokens with the
matching public key. A process configured with only the public key SHALL
never accept an HS256 access token. Core SHALL accept HS256 access tokens
only during one access-token lifetime after it starts signing with Ed25519,
and never when `ACCESS_TOKEN_HS256=off`. When no Ed25519 key is configured,
access tokens SHALL be signed and verified with HS256 exactly as today.
The token claims (`sub`, `email`, `iat`, `exp`) SHALL not change.

#### Scenario: Feature service verifies a core-issued token

- **WHEN** core issues an access token with Ed25519 and the user calls a path served by a feature service
- **THEN** the feature service accepts it using only the public key

#### Scenario: Old token during the switch

- **WHEN** core starts signing with Ed25519 and a user presents an unexpired HS256 token issued before the restart
- **THEN** core accepts it until one access-token lifetime after start
- **AND** rejects HS256 tokens with `invalid_token` after that

#### Scenario: Feature service refuses HS256

- **WHEN** a process holding only the public key receives an HS256 access token
- **THEN** it answers 401 `invalid_token`

### Requirement: Core offers notifications and user names to services

Core SHALL serve `POST /internal/notify`, which sends a live event to the named
users and, when a push is given, a push notification to their registered
devices; and `POST /internal/users/cards`, which returns each named user's id,
VaultID and display name. Only core SHALL decrypt names or hold push
credentials.

#### Scenario: Notify with a push

- **WHEN** a service posts `/internal/notify` with user ids, an event and a push title and body
- **THEN** the users' connected devices receive the event
- **AND** their registered devices receive the push

#### Scenario: User cards

- **WHEN** a service posts `/internal/users/cards` with user ids
- **THEN** core answers with each existing user's id, VaultID and decrypted display name, and omits deleted or unknown users

### Requirement: Internal endpoints accept only internal callers

Core's service endpoints (`/internal/emit`, `/internal/chat-event`,
`/internal/notify` and `/internal/users/cards`) SHALL require an
`X-Internal-Key` header matching either the legacy shared internal key or one
of the per-service keys core is configured with, compared in constant time.
With no key configured, each of them SHALL answer 403. The signed LiveKit
webhooks and the metrics scrape keep their existing guards.

#### Scenario: Wrong key

- **WHEN** a request reaches `/internal/notify` with a missing or unknown key
- **THEN** core answers 403 and does nothing

#### Scenario: Per-service key

- **WHEN** core is configured with a key for `golive` and Go Live posts with that key
- **THEN** core accepts the request

### Requirement: Each service has its own database login and reads membership live

The database SHALL have one role per feature service with rights only on that
service's tables, and a read-only `chat_membership` view of current members
(`chat_id`, `user_id`, `role`, `joined_at`) readable by the Family Space and
Calls roles. The roles SHALL be created unable to log in; an operator arms one
when its service moves.

#### Scenario: Service login cannot touch another service's table

- **WHEN** the Go Live role selects from `shopbook_order`
- **THEN** the database refuses with a permission error

#### Scenario: Removed member disappears from the view

- **WHEN** a member leaves or is removed from a chat
- **THEN** the next read of `chat_membership` no longer returns that member
