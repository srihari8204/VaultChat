# Proposal

## Why

`microservices-prepare` made one image able to start as any service, but every
path is still served by the single go-api container. The plan's phase 3 moves
features out one at a time, and Maps is the pilot: 560 lines, four routes, no
tables and nothing depending on it but ShopBook's distance matrix. It sets the
pattern every later move copies: a container from the same image, a Caddy
route with core as the fallback, its own database login, its own internal key,
and a metrics target.

## What Changes

- **Core signs logins with Ed25519 on the box.** The private key is generated
  into `secrets/access-token/`, mounted into go-api only; the public key into
  `secrets/access-token-pub/`, mounted into Maps only. HS256 is closed 15
  minutes later with `ACCESS_TOKEN_HS256=off`. The compose entries are safe to
  ship before the key exists (empty path, directory mounts), because
  `scripts/deploy.sh` ships them and recreates go-api on every deploy.
- **A `maps-api` container.** Same build as go-api, `SERVICES=maps`, compose
  profile `split` so a plain `up` never starts it. No core env file and no core
  secrets: its own `svc_maps` login (migration 139), its own internal key, the
  public key only.
- **Caddy sends `/nav/*` to `maps-api` first and go-api second.** Active
  health checks on `/livez`; while Maps is down every request lands on core,
  which still serves the same paths.
- **Prometheus scrapes `maps-api`.**
- **`deploy/maps-split.sh`** runs the box-side steps in
  `/home/srihari/vaultchat-clean` under project `vaultchat` (preflight, keys,
  hs256-off, start, route, stop, status, keys-rollback), each checked and
  reversible. The config itself ships with `scripts/deploy.sh`.
- **`deploy/microservices-prepare.sh` is retired.** It targeted the stale
  `/home/srihari/vaultchat` checkout; `scripts/deploy.sh` is the deploy path.

### Already built (reused)

- `SERVICES`, the Ed25519 verify path, the feature-mode boot checks, per-service
  internal keys and the `svc_maps` role, all from `microservices-prepare`.
- Caddy's `reverse_proxy` with several upstreams, `lb_policy first` and active
  health checks, which is the whole fallback mechanism.

### Not building

- No Go code change; go-api's `/build` fingerprint stays `e0156aa0295d17a7`.
- Core keeps serving `/nav/*` (it stays in core's `SERVICES`) until Maps has
  run a clean week; removing it is a later one-line change.
- ShopBook still calls Valhalla directly for its matrix.
- No new server: Maps runs on the same box beside Valhalla.

## Capabilities

### New Capabilities

- `maps-service`: Maps paths served by their own process, with core as the
  fallback, under their own database login and keys.

### Modified Capabilities

None.

## Impact

- `docker-compose.yml` (new `maps-api` service, profile `split`),
  `docker-compose.prod.yml` (go-api key mount and three env passthroughs;
  `maps-api` public-key mount), `caddy/Caddyfile` (`@maps` block),
  `monitoring/prometheus.yml` (scrape job), new `deploy/maps-split.sh`,
  retired `deploy/microservices-prepare.sh`.
- New root `.env` values on the box, written by the script:
  `ACCESS_TOKEN_PRIVATE_KEY_FILE`, `INTERNAL_SERVICE_KEYS`, `MAPS_INTERNAL_KEY`,
  `SVC_MAPS_DB_PASS`, `VALHALLA_URL` if go-api sets one, and later
  `ACCESS_TOKEN_HS256=off`.
- Requires `microservices-prepare` deployed and migration 139 applied.
