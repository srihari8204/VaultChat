# Spec Delta

## Purpose

Serves the Maps paths from their own process, as the first feature moved out of
the core API, without changing anything the app sees and with core as a live
fallback.

## ADDED Requirements

### Requirement: Maps paths are served by the Maps process when it is healthy

The edge SHALL send every request under `/nav/` to the Maps process while that
process passes its health check, and to the core API otherwise. The app SHALL
keep calling the same URL and paths.

#### Scenario: Maps healthy

- **WHEN** the Maps process is up and a user requests `POST /nav/route`
- **THEN** the Maps process serves it

#### Scenario: Maps down

- **WHEN** the Maps process is stopped or failing its health check
- **THEN** `POST /nav/route` is served by the core API with the same response contract

### Requirement: The Maps process holds no core secrets

The Maps process SHALL run without the core env file, the login signing
secret, the master key and push credentials. It SHALL verify logins with the
Ed25519 public key only, connect to the database as `svc_maps`, and reach core
with its own internal key.

#### Scenario: Maps verifies a core-issued login

- **WHEN** core issues an Ed25519 access token and the app calls `/nav/route`
- **THEN** the Maps process accepts the token using only the public key

#### Scenario: Maps cannot read application tables

- **WHEN** the Maps process's database login selects from `users`
- **THEN** the database refuses with a permission error

### Requirement: The move is reversible without a deploy

Pointing `/nav/` back at core SHALL need only the previous edge configuration
and a proxy reload: no image build, no core restart, no data change.

#### Scenario: Unroute

- **WHEN** the operator restores the previous edge configuration and reloads the proxy
- **THEN** every `/nav/` request is served by core again
