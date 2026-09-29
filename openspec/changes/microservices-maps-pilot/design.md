# Design

## Context

See proposal.md. Constraints on the Hetzner box that shape this:

- The live stack runs from `/home/srihari/vaultchat-clean` as compose project
  `vaultchat` (`-p vaultchat`; the directory name differs). `scripts/deploy.sh`,
  run from a clean local checkout, rsyncs the Go tree, migrations, both compose
  files, `monitoring/` and `caddy/` there, applies migrations, and recreates
  go-api only. It does not reload Caddy.
- Caddy mounts `caddy/Caddyfile` as a single read-only file. A single-file bind
  mount follows the inode, so the file must be rewritten in place, never
  replaced by `mv`, or the container keeps reading the old one.
- PgBouncer (`edoburu/pgbouncer`) is configured with one login, `vaultchat`,
  so another role cannot authenticate through it.
- `secrets/` is `700 root:root`, credentials `600` owned by uid 1000, the
  container's `app` user.

## Goals / Non-Goals

**Goals:** the pattern for every later move, proven on the smallest feature;
every step checked and reversible on its own.

**Non-Goals:** removing `/nav/*` from core; ShopBook's direct Valhalla calls; a
separate server for Maps.

## Decisions

### D1. Same image, profile `split`

`maps-api` builds from the same context as go-api and differs only in env. The
`split` profile keeps a plain `dc up -d` from starting it before its secrets
exist, which would otherwise crash-loop on the boot checks.

### D2. Direct Postgres, pool of 2

Maps touches no tables; its only queries are `/ready`'s ping. Connecting to
`postgres:5432` as `svc_maps` with `DB_POOL_MAX=2` avoids reconfiguring
PgBouncer for a second login. When a feature with real traffic moves, PgBouncer
gets an `auth_query` or a userlist entry instead.

### D3. Caddy fallback by active health check

```
@maps path /nav/*
handle @maps {
    reverse_proxy maps-api:4000 go-api:4000 {
        lb_policy first
        lb_try_duration 5s
        fail_duration 30s
        health_uri /livez
        health_interval 5s
    }
}
```

`lb_policy first` picks the first healthy upstream. `/livez` touches nothing,
so a slow database never flips traffic. Tested with Caddy 2.10.2 and two stand-in
backends: the request made the instant Maps died was served by core with no
error, and Maps took traffic back 30 s after returning (`fail_duration`).

### D4. Keys in `secrets/`, values in the root `.env`

The Ed25519 private key lives in `secrets/access-token/`, mounted into go-api
only; the public key in `secrets/access-token-pub/`, mounted into `maps-api`
only. Directory mounts, and a key path that is empty until the script sets it,
make the compose files safe to ship before the key exists: Docker creates a
missing directory empty, and an empty path keeps go-api on HS256. Generated values (the Maps internal
key, `INTERNAL_SERVICE_KEYS`, the `svc_maps` password) go into the project-root
`.env`, which compose interpolates, rather than `vaultchat-backend/.env`, which
`maps-api` must never load.

### D5. Config ships with `scripts/deploy.sh`; routing follows the container

The box tree is not a git checkout, so the box script copies no config: it
checks that `deploy.sh` has shipped it (`preflight`). The `@maps` block is inert
while `maps-api` is stopped, since health checks send everything to go-api, so
`route` is only a validated Caddy reload and the undo is `stop`. Removing the
move for good is deleting the block and deploying.

## Risks / Trade-offs

- [Recreating go-api for the key switch drops every WebSocket once] → Phones
  reconnect on their own; do it outside peak hours.
- [A mistake in the Caddyfile takes down the whole edge] → `caddy validate`
  runs inside the container before `caddy reload`, and a failed validation
  restores the previous file.
- [HS256 window reopens for 15 minutes on every core restart until
  `ACCESS_TOKEN_HS256=off` is set] → the `hs256-off` step sets it.
- [While `maps-api` is absent, Caddy's active health check logs a failed probe
  every 5 s] → Only after Caddy has reloaded the block and before `start`, or
  after `stop`; run the steps back to back.
- [Running a box command in the stale `/home/srihari/vaultchat`] → the script
  refuses any tree but `/home/srihari/vaultchat-clean`, and every compose call
  carries `-p vaultchat`.

## Migration Plan

`scripts/deploy.sh` (ships config, applies 139) → `preflight` → `keys` → wait
15 minutes and check a phone → `hs256-off` → `start` → `route` → a clean week →
a later change removes `maps` from core's `SERVICES`.

Rollback: `stop` (Caddy falls back to go-api within 5 s). `keys-rollback`
stops maps-api, removes the key path from `.env` and recreates go-api on HS256;
phones refresh their tokens once (any 401 triggers one refresh).
