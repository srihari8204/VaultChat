# Design

## Context

See proposal.md (Why). The backend has one HTTP package (`internal/routes`).
Process-level service selection already exists (`internal/services`,
`cmd/api/routes.go`), and Maps already runs as its own container
(`microservices-maps-pilot`). Packages such as `httpx`, `redisx` and `db` are
infrastructure helpers used directly by handlers.

## Goals / Non-Goals

**Goals:**
- One layout every backend module follows, with the domain at the centre and
  the application layer around it.
- A dependency rule that is checked by `go test`, not only by review.
- Business rules testable without HTTP, Redis, Postgres or engines.
- A pilot that changes zero client-visible bytes.

**Non-Goals:**
- Converting every module in one change (see proposal, Not building).
- Abstracting `httpx`/`redisx` behind ports. They are only reached from
  adapters, so wrapping them would add indirection with no test benefit today.

## Decisions

### D1. Packages per layer, inside a module folder

`internal/<module>/{domain,app,adapters/<name>}` plus `<module>.go` as the
composition root. Go packages turn the dependency rule into a compile-time
fact: `domain` cannot see `app`, and an import cycle is a build error.
*Alternative:* one package per module, with layers expressed only as files.
This is cheaper but unenforceable, which is how `routes` reached 58k lines.

### D2. Ports are declared by the application layer, next to their use

`app/ports.go` declares `RoutingEngine` and `Geocoder` in the shape the use
cases need (domain types in, domain types out). Engine wire formats such as
Valhalla JSON stop in the adapter. The one exception is `Route`, which returns
the engine's bytes because the client renders Valhalla's route verbatim today.
Changing that would be an API change. Port errors are sentinel values plus
`*RefusedError`, so the inbound adapter can map them onto the existing status
codes.
*Alternative:* ports in `domain`. This was rejected because ports are the
needs of the use cases, not domain concepts.

### D3. Input validation that is a business rule lives in app/domain

Coordinate validity, the costing whitelist, the source cap, the 2–200 query
length and dropping inapplicable route options are rules, so they live in
`domain`/`app`. Decoding JSON, the auth gate, rate limits and choosing status
codes and messages are transport concerns, so they live in `adapters/httpapi`.

### D4. Rate limiting stays in the inbound adapter

Per-user request budgets protect the endpoint, not the domain. They stay as
direct `redisx.Consume` calls in `httpapi`, with the same keys and limits.

### D5. The dependency rule is a test, `internal/archcheck`

The test parses the imports of every `internal/*/domain` and `internal/*/app`
package. `domain` may import the standard library only. `app` may import the
standard library and `…/domain` only. Test files are exempt, so fakes can live
next to the code. It fails if it finds no module, so a moved tree cannot pass
it silently.
*Alternative:* `depguard` in golangci-lint. This was rejected because the repo
does not run golangci-lint, and the check would be a new dependency.

### D6. Behavior equivalence is proven against the old code

`adapters/httpapi/httpapi_test.go` drives the real inbound and outbound
adapters against stub Valhalla and Photon servers and pins status codes and
exact bodies. The same tests were run, renamed, against the pre-change
`routes/nav.go` and passed, so both implementations produce identical bodies.
JSON DTOs order their fields alphabetically to match the sorted keys that the
replaced `map[string]any` produced.

### D7. Order of the remaining conversions

Leaf modules come first and core comes last: Games → Calls → Go Live → Family
Space → ShopBook → core. This follows the microservices plan's extraction
order, so each module gets its hexagon before it gets its container. ShopBook
waits until after Maps so its road-distance code can call Maps'
`RoutingEngine` port instead of duplicating Valhalla calls.

### D8. Shared infrastructure leaves `routes` as its own package

An adapter must not import `internal/routes`: that would drag every handler
into each module and recreate the coupling. When a converted module needs a
helper that `routes` still uses, the helper moves to a small package of its
own, such as `internal/devices` (FCM token lookup, registration and cleanup,
shared by Calls, chat and Games). Callers in `routes` switch to it in the same
change.

### D9. DB-backed contract tests for modules with storage

When a module reads and writes Postgres, stub engines are not enough to prove
the behavior is unchanged. Its contract test runs every endpoint against a
scratch database with all migrations applied (`CALL_TEST_DB=1`, as the
existing route tests do). It masks volatile values and compares the result
with a golden file recorded from the pre-change handlers. Games' test found a
real bug on its first run (task 4.1a). That bug is fixed in its own commit, and
the golden was re-recorded from the fixed old code, so the refactor commit
still changes no behavior.

## Risks / Trade-offs

- [Duplicate Valhalla matrix decoding in `routes/shared_valhalla.go` (ShopBook)
  and `maps/adapters/valhalla`] → Removed when ShopBook converts (task 4.5).
- [More files and packages per module] → The cost is paid only by modules
  that convert. `archcheck` keeps the shape honest, so the extra files are not
  ceremony without enforcement.
- [Env vars read at startup instead of per request (`VALHALLA_URL`,
  `GEOCODE_UPSTREAM`)] → Both are fixed for a container's lifetime, and a change
  already requires a restart under compose.

## Migration Plan

Ship the rebuilt Go image with `scripts/deploy.sh`. Rollback restores the
previous image the script backs up. There is no migration or config change.
Each later module conversion follows the same written → deployed →
device-verified path on its own.
