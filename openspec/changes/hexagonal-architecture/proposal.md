# Proposal

## Why

The Go backend serves almost every request through `internal/routes`: 58k lines
in one package where each handler decodes the request, applies the business
rules, calls Postgres/Redis/Valhalla/LiveKit inline and writes the response.
Rules can only be tested through HTTP and real infrastructure. Feature files
reach into each other's helpers. Swapping an engine (Valhalla, Photon,
LiveKit) means editing handlers. `microservices-prepare` started splitting the
backend by service, and each service needs a clear inside and outside before
it moves. This change adopts hexagonal architecture (ports and adapters), with
the **domain** at the core, wrapped by the **application** layer, and
converts Maps as the pilot.

## What Changes

- **Layering convention for backend modules.** A module lives at
  `internal/<module>/` with:
  - `domain/`: entities, value objects and pure rules. Standard library only.
  - `app/`: use cases, plus the **ports** (Go interfaces) they need from the
    outside. Imports only the standard library and `domain`.
  - `adapters/<name>/`: inbound adapters (HTTP handlers) and outbound adapters
    (Valhalla, Photon, and later Postgres, Redis, LiveKit, R2) that implement
    the ports.
  - `<module>.go`: the composition root. It builds the adapters from the
    environment and mounts the inbound adapter.
- **The dependency rule is enforced.** `internal/archcheck` fails `go test` when
  a `domain` package imports anything outside the standard library, or an `app`
  package imports anything but the standard library and `domain`. New modules
  are picked up automatically.
- **Maps is converted.** `internal/routes/nav.go` is replaced by `internal/maps`
  (domain: coordinates, costings, route options, track decimation, matrix
  index remapping, place labels; app: Route, Matrix, Trace, Geocode use cases
  with `RoutingEngine` and `Geocoder` ports; adapters: `httpapi`, `valhalla`,
  `photon`). `/nav/*` keeps the same paths, auth, rate limits, status codes,
  messages and response bytes. Contract tests pin this and also pass against
  the old `nav.go`.
- **Remaining modules convert one at a time** (tasks group 4). Each module is
  its own reviewable change, in this order: Games, Calls, Go Live, Family
  Space, ShopBook (which then reuses Maps' `RoutingEngine` instead of its own
  Valhalla calls), then core (chats, auth, user, uploads, VaultBeam).

### Already built (reused, not rebuilt)

- `internal/services` (`SERVICES`) and `cmd/api/routes.go` from
  `microservices-prepare` decide which modules a process mounts. Maps keeps its
  `services.Maps` gate, so `maps-api` from `microservices-maps-pilot` works
  unchanged.
- `httpx` (auth, JSON, errors) and `redisx` (rate limits) are reused by
  inbound adapters as-is. They are adapters' tools, not ports.
- The existing Maps unit tests moved into `internal/maps/domain` with the same
  cases.

## Not building

- **No big-bang rewrite.** Only Maps moves in this change's written work. Every
  other module stays in `internal/routes` until its own task group lands.
- **No client (React Native) restructuring.** The app is a thin client by
  project convention. Its shared-logic boundary is already defined by
  `app-uniffi-core-architecture`.
- **No Node backend changes.** `vaultchat-backend` runs background jobs only.
- **No DI framework, no generic repository layer, no new dependencies.** Ports
  are small per-module Go interfaces, and wiring is plain constructors in the
  composition root.
- **No API, schema or behavior change.** No migration and no new env vars.

## Capabilities

### New Capabilities

None. This is a structural refactor with no change in observable behavior, so
the change sets `skip_specs: true`. The layering rule is enforced by
`internal/archcheck` and documented in `design.md` and `ARCHITECTURE.md`.

### Modified Capabilities

None.

## Impact

- Go backend: new `internal/maps/**`, `internal/archcheck/`; `internal/routes/nav.go`
  removed; `cmd/api/routes.go` mounts `maps.Register`; comment in
  `internal/routes/shared_valhalla.go`.
- Deploy: the Go image must be rebuilt and shipped with `scripts/deploy.sh`
  (go-api and, when split, maps-api). No migration (139 stays the latest for
  this change), no config change.
