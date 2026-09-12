# VaultChat — Production Operations (Go-first, Hetzner box)

Day-to-day runbook for the live deployment on `vaultchatprod01`
(`65.21.229.167`), serving `https://api.corefinite.com`.

## Serving chain

```
Cloudflare (proxy, WebSockets on, SSL Full)
  └─► host nginx :443  (Let's Encrypt TLS, /etc/nginx/sites-enabled/vaultchat)
        └─► Caddy  127.0.0.1:8095   (ingress + per-route switch)
              └─► go-api :4000       (all 17 REST modules + Socket.IO, in-process fan-out)
```

Supporting containers (Docker Compose project `vaultchat`, default profile):
`pgbouncer` · `postgres` · `redis` · `minio` · `valhalla` · `coturn`.

Everything else is behind a profile and does NOT start with a bare `dc up -d`
(verified with `dc config`, which omits non-default-profile services):

| profile | services | note |
|---|---|---|
| `sfu` | `livekit`, `egress` | calling SFU — needed for group calls |
| `golive` | `golive-livekit`, `golive-egress` | broadcasting SFU |
| `monitoring` | `prometheus`, `grafana` | scrapes `go-api:4000/internal/metrics` direct, not via Caddy |
| `legacy` | `api` (Node), `kafka`, `fanout-worker` | emergency rollback only |

**No Node process runs in the default profile.** `vaultlens-worker` was the last
one and it was removed with the VaultLens feature (compose service deleted, see
`docker-compose.yml:629`; schema dropped by migration `098_drop_vaultlens.sql`).
`dc logs vaultlens-worker` / `dc up -d vaultlens-worker` now fail with "no such
service".

## The `dc` alias — ALWAYS use it

The stack is three compose files. Running `docker compose` without all three
re-exposes ports and pulls up legacy services. Make the alias permanent:

```bash
echo "alias dc='docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml'" >> ~/.bashrc
source ~/.bashrc
```

> `docker-compose.box.yml` is **box-specific** (not in git — host nginx owns
> 80/443, so Caddy binds a private port instead). Recreate it if lost:
>
> ```yaml
> services:
>   caddy:
>     ports: !override ["127.0.0.1:8095:80"]
>   go-api:
>     ports: !override []
>   minio:
>     ports: !override ["19000:9000"]
> ```

## Everyday commands

```bash
dc ps                                   # what's running
dc logs go-api -f                       # live tail (Ctrl+C to stop)
dc restart <service>                    # bounce one service
curl -s http://127.0.0.1:8095/health ; echo    # Go health via Caddy
curl -s https://api.corefinite.com/health ; echo  # public (through CF+nginx)
```

Healthy response: `{"db":true,"redis":true,"status":"ok",...}`.

## Deploy a code update

```bash
# from a dev machine: push to hetzner-deploy, then on the box:
cd /home/srihari/vaultchat
git pull
dc up -d --build go-api                 # rebuild just Go (Docker compiles it; no host Go)
dc logs go-api --tail 20
```

Docker builds Go inside the image (`golang:1.26-alpine` → `alpine:3.20`). Rust
and Kotlin are **mobile-only** — they never run on this server.

## Database migrations

```bash
dc --profile legacy run --rm api node migrate.js up     # applies pending; 'nothing to apply' if current
dc exec postgres psql -U vaultchat -d vaultchat -c '\dt' | head
```

> **Migrate BEFORE `dc up -d --build go-api`, not after.** These migrations are
> additive, so the running old binary tolerates a schema that has run ahead of
> it; a new binary against a schema that has NOT caught up does not.
>
> `127_refresh_token_lookup.sql` is the live example and is **still pending**
> (ledger last checked at 126). `internal/routes/auth.go` and `user.go` name
> `refresh_tokens.token_lookup` and `revoked_reason` in ordinary SQL with no
> feature flag and no capability probe, so a go-api built from current `main`
> and started against a pre-127 schema answers **every sign-in, token refresh
> and session-list request with 42P01** — a total auth outage, not a degraded
> feature. It also needs `VAULTCHAT_LOOKUP_PEPPER` set (see
> `vaultchat-backend/.env.example`); unset, the column stays NULL and every
> refresh silently falls back to the 500-row legacy scan.

## Rollback to Node (emergency)

The Node image is still in the `legacy` profile; the DB is shared, so no data
migration is needed either way.

```bash
dc --profile legacy up -d api                                          # Node on :3000 (internal)
sudo sed -i 's|127.0.0.1:8095|127.0.0.1:13000|' /etc/nginx/sites-enabled/vaultchat
sudo nginx -t && sudo systemctl reload nginx                          # public traffic → Node
```

Reverse both edits (`13000`→`8095`, `dc stop api`) to return to Go.

## Known follow-ups (non-blocking)

- **valhalla** — routing (`POST /nav/route`) is down until an OSM extract is
  present. Drop `<region>.osm.pbf` into `valhalla/custom_files/`, then
  `dc up -d valhalla` (first boot builds tiles; minutes). Chat/calls/media are
  unaffected.
- **VaultLens AI avatars** — feature REMOVED. The compose service, the worker
  code and the `vaultlens_*` tables are all gone (migration 098). Nothing to
  start; `MODELSLAB_API_KEY` is read by nothing.

## Gotchas learned in production

- **`sudo -u postgres psql` on the box is NOT production.** The host cluster
  (`postgresql@16-main`, `127.0.0.1:5432`) still holds a `vaultchat` database
  left over from before the July 2026 cutover — migration **060**, 6 users,
  newest row 2026-07-22. Production is the **container**: `go-api` →
  `DB_HOST=pgbouncer` → `vaultchat-pgbouncer-1` → `vaultchat-postgres-1`, at
  migration **126**. Reading the host copy makes prod look ~66 migrations behind
  and has already misled one deploy. Always:

  ```bash
  dc exec postgres psql -U vaultchat -d vaultchat -tAc 'SELECT max(version) FROM schema_migrations'
  ```

  **Defused 2026-09-07**, so the command above now fails loudly instead of
  lying: the stale database was renamed to `vaultchat_stale_20260722`, and the
  host `pgbouncer.service` (`0.0.0.0:6432`, which proxied *only* to it and had
  logged 0 logins in 7 days) was stopped and disabled. `sudo -u postgres psql -d
  vaultchat` now answers `FATAL: database "vaultchat" does not exist`. Prod was
  untouched — go-api never restarted, and the container `pgbouncer`/`postgres`
  pair is a different thing entirely, despite the shared names.

  A `pg_dump -Fc` of the stale database is in
  `/root/stale-host-pg/vaultchat-hoststale-20260907.dump`. The renamed database
  still exists and still holds 6 users' PII; drop it once the dump is somewhere
  you trust.

- **The migration files are not the schema.** Later migrations drop tables that
  earlier ones create, so grepping `CREATE TABLE` over
  `vaultchat-backend/migrations/*.sql` yields tables that do not exist —
  `message_reactions` (dropped in 056), `vaultlens_face` and
  `vaultlens_generation` (098). One `DELETE FROM` against a dropped table aborts
  the whole transaction with 42P01. Check the live catalog before writing
  multi-table SQL:

  ```sql
  SELECT t FROM unnest(ARRAY['a','b','c']) t WHERE to_regclass('public.'||t) IS NULL;
  ```

- **Never drop the `-f` flags** — a bare `docker compose up` recreates
  postgres/redis with public bench ports (`0.0.0.0:15432/16379`) and starts
  kafka. Always use `dc`.
- **Recreated infra → stale IPs.** If a worker logs `ECONNREFUSED <ip>:6379`
  after Redis was recreated, `dc up -d --force-recreate redis go-api`.
- **`nginx -t` after any vhost edit**, and keep backups OUT of
  `sites-enabled/` (nginx loads every file there, incl. `*.bak`).
- **Socket.IO is websocket-only by design** (`internal/realtime/server.go`
  pins the transport). A `transport=polling` probe returning
  `{"code":0,"message":"Transport unknown"}` is correct, not a fault.
