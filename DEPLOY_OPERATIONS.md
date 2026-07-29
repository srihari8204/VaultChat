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
`postgres` · `redis` · `minio` · `valhalla` · `coturn` · `vaultlens-worker` (Node, BullMQ).
Behind `--profile legacy` (NOT started): `api` (Node), `kafka`, `fanout-worker` —
kept only for emergency rollback.

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
dc logs vaultlens-worker --tail 20
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
- **VaultLens AI avatars** — set `MODELSLAB_API_KEY` in
  `vaultchat-backend/.env`, then `dc up -d vaultlens-worker`.

## Gotchas learned in production

- **Never drop the `-f` flags** — a bare `docker compose up` recreates
  postgres/redis with public bench ports (`0.0.0.0:15432/16379`) and starts
  kafka. Always use `dc`.
- **Recreated infra → stale IPs.** If a worker logs `ECONNREFUSED <ip>:6379`
  after Redis was recreated, `dc up -d --force-recreate redis vaultlens-worker`.
- **`nginx -t` after any vhost edit**, and keep backups OUT of
  `sites-enabled/` (nginx loads every file there, incl. `*.bak`).
- **Socket.IO is websocket-only by design** (`internal/realtime/server.go`
  pins the transport). A `transport=polling` probe returning
  `{"code":0,"message":"Transport unknown"}` is correct, not a fault.
