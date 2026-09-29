# Proposal

## Why

`docs/MICROSERVICES_PLAN.html` splits the Go backend into core plus six feature
services (Go Live, Family Space, Games, Maps, ShopBook, Calls). Its phase 2,
"Prepare the codebase", has to land before any feature can move: today one
image can only start as everything, every process verifies logins with the
same shared secret, and feature files call each other's helpers. This change is
that preparation. Nothing moves yet; with the default settings the API behaves
exactly as it does now.

## What Changes

- **SERVICES setting.** `cmd/api/main.go` groups route registration and
  background jobs by service. `SERVICES=all` (the default, and what an unset
  variable means) keeps today's behaviour. `SERVICES=golive` (or any single
  feature) starts only that feature's routes and jobs and sends live events to
  core through the existing `/internal/emit` bridge.
- **Every background job runs once.** Each ticker takes a transaction-scoped
  Postgres advisory lock before it runs, so a second copy of a service skips
  the tick instead of running it twice.
- **Ed25519 access tokens.** Core signs access tokens with an Ed25519 private
  key when one is configured; every process verifies them with the public key.
  Core keeps accepting the HS256 tokens it issued before the switch for one
  access-token lifetime, then stops. Without a key configured, nothing changes.
- **Core internal endpoints.** `POST /internal/notify` (live event plus push to
  offline devices) and `POST /internal/users/cards` (display names, which only
  core can decrypt), each guarded by a per-service internal key.
- **Per-service database logins.** Migration 139 creates one NOLOGIN role per
  feature service with rights on that service's tables only, and a read-only
  `chat_membership` view that Family Space and Calls read instead of copying
  membership.
- **Shared helpers leave feature files.** The per-user query helpers
  (`chatsQRow`, `chatsQueryU`, `chatsExecU`) and text helpers (`chatsStrOr`,
  `truncRunes`, `orEmpty`) move to shared files; `spaceName` and
  `chatsAudienceAllowed`, which serve chat, move to chat files.

### Already built (reused, not rebuilt)

- `internal/emitx` already bridges live events to another process over
  `POST /internal/emit` when no local hub is wired, and already has a
  `NotifyUsers` client for `/internal/notify` (the old Node endpoint, which no
  longer exists on the Go side).
- The games launch token (`internal/routes/games.go`) already signs Ed25519
  with a key loaded from a PEM file; the access-token key uses the same format.
- Migration 133 already sets the pattern for NOLOGIN roles armed by an operator.
- ShopBook's hourly tick already takes a Redis `SETNX` lock (C2); it stays.
- `pg_try_advisory_xact_lock` is already how the partition maintainer runs once.

### Not building

- No service is moved out, no Caddy route changes, no new container. Those are
  phase 3, one feature at a time.
- No Family Space column move (the plan puts it in the Family Space move).
- Feature code that still reads `users` or writes `devices` directly is not
  rewritten here; each feature switches to the core endpoints when it moves.
- No message broker, no second socket, no separate database server.
- No change to the HLS ticket or invitation HMACs beyond what is listed.

## Capabilities

### New Capabilities

- `service-split`: how one backend image starts as core or as a single feature
  service, how services authenticate users and each other, how background jobs
  stay single-run, and how database access is scoped per service.

### Modified Capabilities

None.

## Impact

- `vaultchat-backend-go/cmd/api/main.go`, new `internal/services`,
  `internal/jobs/jobs.go` and a job-lock helper, `internal/httpx/httpx.go`,
  `internal/routes/auth.go`, the three reapers and `shopbook_jobs.go`, new
  core internal handlers, `internal/routes/chats.go` (Family Space
  registration), and the helper files named above.
- New migration `vaultchat-backend/migrations/139_service_roles.sql`.
- New optional env: `SERVICES`, `ACCESS_TOKEN_PRIVATE_KEY_FILE`,
  `ACCESS_TOKEN_PUBLIC_KEY_FILE`, `INTERNAL_SERVICE_KEYS`. All unset in
  production today, which keeps current behaviour.
- The app is unaffected: same URL, same paths, same token shape to the client.
