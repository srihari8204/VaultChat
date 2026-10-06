# Tasks

Levels: **written** = in the repo with its checks passing; **deployed** = the
files are on prod and running; **device-verified** = checked on two phones.
A task is done only at the level it states.

## 1. Convention and guard (written)

- [x] 1.1 Add `internal/archcheck/layers_test.go` enforcing domain → stdlib only and app → stdlib + domain only, for every `internal/*/{domain,app}`; verify with `go test ./internal/archcheck/` passing, and failing when `internal/maps/app` imports `httpx`
- [x] 1.2 Document the layout and dependency rule in `ARCHITECTURE.md` ("Backend module layout: hexagonal"); verify the section names the folders, the rule and the guard test

## 2. Maps pilot (written)

- [x] 2.1 `internal/maps/domain`: `LatLng.Valid`, `ParseCosting`, `RouteOptions.For`, `Decimate`, `Legs`, `Metres`/`Seconds`, `PlaceLabel`; the old `nav_matrix_test.go`/`nav_trace_test.go` cases moved here; verify with `go test ./internal/maps/domain/`
- [x] 2.2 `internal/maps/app`: `RoutingEngine` and `Geocoder` ports, `Service` with Route, Matrix, Trace (split-and-sum), Geocode; verify with fake-port tests in `go test ./internal/maps/app/`
- [x] 2.3 Outbound adapters `adapters/valhalla` and `adapters/photon`; inbound adapter `adapters/httpapi` (same paths, auth, rate-limit keys, statuses, messages); composition root `internal/maps/maps.go`; `cmd/api/routes.go` mounts `maps.Register` under `services.Maps`; delete `internal/routes/nav.go`; verify with `go build ./...` and `go vet ./...`
- [x] 2.4 Contract tests in `adapters/httpapi/httpapi_test.go` pin bodies for matrix, route, trace and geocode against stub engines; verify they pass here AND, renamed, against the pre-change `routes/nav.go`
- [x] 2.5 Ponytail review of the diff; `go test ./...` (only pre-existing env failure: `internal/vault` TestVaultInterop needs `@node-rs/argon2` installed) and `openspec validate hexagonal-architecture --strict`

## 3. Maps pilot deploy (deployed, device-verified)

Files to ship: the `vaultchat-backend-go/` tree (image rebuild) with
`scripts/deploy.sh`. No migration (latest stays 139), no config change.

- [ ] 3.1 `bash scripts/deploy.sh`: go-api healthy and its `/build` fingerprint matches the new tree; if `maps-api` is running, recreate it from the same image (`deploy/maps-split.sh start`) and confirm `services: maps` in its boot log (deployed)
- [ ] 3.2 Through Caddy, `/nav/route` without a token answers 401 and with one answers a route (deployed)
- [ ] 3.3 On two phones: route with alternates, avoid-tolls, address search, Meet Here distances, and a family trip's driven distance all show as before (device-verified)

## 4. Remaining modules (one change-sized group each, written → deployed → device-verified)

Each item: move into `internal/<module>/{domain,app,adapters}` with ports for
its Postgres/Redis/engine use, pass `archcheck`, keep its existing route tests
green, add contract tests for any endpoint whose handler is rewritten, then
deploy and device-verify as in group 3.

- [x] 4.1 Games, written: `routes/games*.go` → `internal/games` (domain: slugs, text bounds, display name, table kinds, voice rooms, Pool/Deals scoring; app: launch token, voice token, notify, live tables, device token, matches behind `Players`/`LaunchSigner`/`NotifyVerifier`/`VoiceTokens`/`Tables`/`Dedupe`/`Devices`/`Pusher`/`Matches`; adapters: `httpapi`, `postgres`, `launchtoken`, `notifykey`, `livekitvoice`, `push`). Push-device helpers moved from `routes/devices_push.go` to `internal/devices` so Calls and Games share them without importing `routes`. Verify: unit tests per layer; DB-backed `internal/games/contract_test.go` (50 steps, `CALL_TEST_DB=1`) matches `testdata/games_contract.golden`, recorded from the pre-change handlers; DB-backed `internal/routes` failures identical before and after (5, all needing fixtures this change does not touch)
- [x] 4.1a Fix found by 4.1's contract test, shipped as its own commit: `POST /games/matches/deal` always answered 500 because the scores were bound as `[]byte` (sent as bytea in exec mode) to a JSONB column; now bound as a string. Verify: contract steps `match/deal-*` answer 200 with scores
- [ ] 4.1b Deploy (deployed): ship the Go tree with `scripts/deploy.sh` to the box only, NOT via the `hetzner-deploy` branch until the user says so; no migration (125/126 already applied), no config change. Through Caddy: `/games/launch-token` 401 without a token
- [ ] 4.1c Device-verified: open a game (launch token), table voice as player and spectator, a turn push arrives and the live-tables row opens the table, a Pool 101 match scores two deals on two phones
- [ ] 4.2 Calls (`routes/calls.go`, `routes/call_sessions.go`; LiveKit token port)
- [ ] 4.3 Go Live (`routes/golive*.go`, `routes/broadcast*.go`; its own LiveKit stays isolated)
- [ ] 4.4 Family Space (`routes/spaces_*.go`, `space_*.go`, `family_relations.go`)
- [ ] 4.5 ShopBook (`routes/shopbook*.go`); road distances through Maps' `RoutingEngine`, then delete `routes/shared_valhalla.go`
- [ ] 4.6 Core: chats, auth, user, uploads, VaultBeam, stories, channels, communities, contacts
