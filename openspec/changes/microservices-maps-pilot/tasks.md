# Tasks

Levels: **written** = in the repo with its checks passing; **deployed** = on the
box and running; **device-verified** = checked on two phones.

## 1. Config (written)

- [x] 1.1 `docker-compose.yml`: `maps-api` service (same build, `SERVICES=maps`, profile `split`, direct Postgres as `svc_maps`, pool 2, no env file); verify the file parses and `maps-api` carries no `env_file`
- [x] 1.2 `docker-compose.prod.yml`: go-api mounts `secrets/access-token.key` and passes `ACCESS_TOKEN_PRIVATE_KEY_FILE`, `ACCESS_TOKEN_HS256`, `INTERNAL_SERVICE_KEYS`; `maps-api` mounts `secrets/access-token.pub` and publishes no port; verify the file parses
- [x] 1.3 `caddy/Caddyfile`: `@maps` block before the catch-all, `maps-api` first, go-api fallback, `/livez` health check; verify with `caddy validate`
- [x] 1.4 `monitoring/prometheus.yml`: `maps-api` scrape job; verify the file parses

## 2. Box script (written)

- [x] 2.1 `deploy/maps-split.sh` with `preflight`, `keys`, `hs256-off`, `start`, `route`, `stop`, `status`, `keys-rollback`, for `/home/srihari/vaultchat-clean` under `-p vaultchat`; config shipped by `scripts/deploy.sh`, checked in `preflight`; Caddy validated before reload; verify with `bash -n`, shellcheck and a dry run of every step against stub docker/curl
- [x] 2.2 Retire `deploy/microservices-prepare.sh` (it targeted the stale checkout); verify it exits non-zero with a pointer to `scripts/deploy.sh`

## 3. Review (written)

- [x] 3.1 Ponytail review of the diff; `openspec validate microservices-maps-pilot --strict`

## 4. Deploy (deployed)

`scripts/deploy.sh` ships `docker-compose.yml`, `docker-compose.prod.yml`,
`caddy/`, `monitoring/` and migration 139 to `/home/srihari/vaultchat-clean`;
`deploy/maps-split.sh` is copied there by hand (deploy.sh does not sync
`deploy/`). No Go change: go-api's `/build` stays `e0156aa0295d17a7`.

- [ ] 4.0 `bash scripts/deploy.sh` (without `SKIP_MIGRATIONS`): ledger shows 139, go-api healthy
- [ ] 4.1 `preflight` passes: config landed, `svc_maps` exists
- [ ] 4.2 `keys`: go-api boot log says `signing Ed25519`; 15 minutes later `hs256-off`
- [ ] 4.3 `start`: `maps-api` boot log says `services: maps`, `/livez` answers inside the network
- [ ] 4.4 `route`: `caddy validate` passes, `/nav/route` without a token answers 401 through Caddy, and `maps-api`'s request counter moves

## 5. Device verification (device-verified)

- [ ] 5.1 A phone logged in before 4.2 stays logged in after it
- [ ] 5.2 After 4.4: route and road distance on the map screen, address search, then `stop` and the same again (served by core), then `start`
