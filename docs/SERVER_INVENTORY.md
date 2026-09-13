# Production server inventory — 65.21.229.167 (`vaultchatprod01`)

Taken **2026-09-13**, read-only, ahead of a from-scratch rebuild.
Host: Hetzner, Ubuntu 24.04.4 LTS, kernel 6.8.0-124, uptime 89 days.
Disk: `/dev/md2` 436G, 116G used (28%). `/var/lib/docker` 21G, `/home/srihari` 11G, `/data` 707M.

Everything below came from live commands on the box. Where I could not determine
something I say **unknown** rather than guess.

---

## 1. MUST SURVIVE A REBUILD

Loss of any of these is unrecoverable — no file in the repo recreates them.

### 1.1 Credentials and keys — copy these off the box FIRST

| Path | What it is | Why it is unrecoverable |
|---|---|---|
| `/home/srihari/vaultchat-backups/.offsite-key` | AES-256 passphrase for the encrypted R2 off-site DB backups | **The most dangerous file on the box.** Every `db-backups/*.sql.gz.enc` object in R2 is encrypted with it and the passphrase exists ONLY here. Lose it and every off-site restore point becomes unreadable ciphertext. The backup script says so in its own comments. |
| `/home/srihari/vaultchat/.env` (37 keys, 0600 srihari) | `JWT_SECRET`, `ADMIN_KEY`, `TURN_SECRET`, `LIVEKIT_API_*`, `GOLIVE_LIVEKIT_*`, `RESEND_API_KEY`, `SENTRY_DSN`, DB/Redis creds | Rotating `JWT_SECRET` logs out every installed app; `TURN_SECRET` must match what shipped clients use |
| `/home/srihari/vaultchat/vaultchat-backend/.env` (40 keys, 0600) | Adds `VAULTCHAT_MASTER_KEY`, `VAULTCHAT_LOOKUP_PEPPER`, `VAULTBEAM_S3_*` (R2), `GIPHY_KEY`, `TENOR_KEY`, `KLIPY_KEY` | **`VAULTCHAT_MASTER_KEY` + `VAULTCHAT_LOOKUP_PEPPER` decrypt the encrypted-PII columns in Postgres.** Lose them and the database restores intact but unreadable — phone-number lookup and onboarding PII are gone permanently. |
| `/home/srihari/vaultchat/secrets/` (0700 root, 3 files) | `fcm-service-account.json` (push, Firebase project vaultchatprod01), `games-signing.key`, `games-notify.pub` | The FCM service account can be reissued from Firebase; the games keypair must stay matched to the games server |
| `/opt/vaultgames/keys/` (0700 root, 4 files) | `pg.pass`, `notify.key`, `notify.pub`, `ed25519.pub` | `ed25519.pub` pairs with the games binary; `pg.pass` is the `vaultgames` DB role password |
| `/etc/vaultchat-logs.env` | `LOG_TOKEN`, `COMPOSE_DIR` for the admin log API | The token is baked into the admin web UI |
| `/etc/systemd/system/beszel-agent.service` | Holds the beszel `KEY` and `TOKEN` inline in the unit | Re-pairing the agent means re-registering the host with the hub |
| `/root/.ssh/authorized_keys` (2 keys: `vaultchat-claude-admin`, `srihari-vaultchat`) and `/home/srihari/.ssh/authorized_keys` (1 key) | SSH access | `PasswordAuthentication no` — these keys are the only way in |

### 1.2 Volumes holding irreplaceable state

| Volume | Size | Contents | Verdict |
|---|---|---|---|
| `vaultchat_pgdata` | 140 MB | **The product database.** DB `vaultchat` (38 MB, 172 tables, 18 users, `schema_migrations` at **130**), plus `vaultgames` (8 MB — every player balance, rating and friend list) and `vaultchat_authtest` (17 MB) | **MUST SURVIVE** |
| `vaultchat_miniodata` | **6.63 GB** | `vaultchat-broadcast` 5.8 GB, `vaultchat-media` 521 MB | **MUST SURVIVE — this is the only copy. No off-site replication exists for MinIO.** |
| `vaultchat_grafanadata` | 1.02 MB | Grafana users and dashboards. Only the *datasource* is provisioned from `monitoring/grafana-datasource.yml`; **any dashboard built in the UI lives only here** | **MUST SURVIVE** if any dashboard was hand-made — I could not enumerate them read-only |
| `vaultchat_promdata` | 110 MB | Prometheus TSDB | Rebuildable, but all metric history is lost |
| `vaultchat_kafkadata` | 79 MB | Kafka log dirs | **unknown** whether any topic is authoritative; Kafka sits in the `legacy` profile and go-api runs without it by default, so probably transient |
| `vaultchat_redisdata` | 16 MB | Sessions, presence, queues | Transient |
| `vaultgames-data` | 0 B | `/data/games.json` — the *dev* file store. Postgres is the real store | Rebuildable (empty) |
| `portainer_data` | 1.05 MB | Portainer users and settings | Rebuildable by re-onboarding |
| 18 anonymous volumes | mostly 0 B | 3 attached to Kafka (config/secrets), 1 each to golive-redis, coturn, searxng; the rest dangling. One dangling volume `1223249b…` holds a 67 KB searxng `settings.yml`, superseded by the bind mount | Rebuildable |

### 1.3 Host paths that are state, not config

| Path | Size | Note |
|---|---|---|
| `/etc/letsencrypt/` | 572 KB | **8 certificate lineages plus the ACME account key.** See §6 — losing this creates a real rate-limit risk. |
| `/home/srihari/vaultchat-backups/` | 58 MB | 16 nightly dumps, the `.offsite-key`, and hand-made pre-migration dumps (`pre-084…`, `pre110…`) |
| `/opt/vaultgames/backups/` | ~120 KB | 15 nightly `vaultgames` dumps |
| `/home/srihari/vaultchat/valhalla/custom_files/` | **9.8 GB** | `india-latest.osm.pbf` (1.7 GB), `valhalla_tiles.tar` (4.4 GB), `valhalla.json`. Technically rebuildable — but that is a 1.7 GB download plus a multi-hour tile build, during which in-app turn-by-turn navigation is dead. **Copy it; do not rebuild it.** |
| `/data/jumpserver/` | 707 MB | JumpServer state (postgresql 395 MB, core 129 MB, koko 100 MB, nginx logs 84 MB) — only if JumpServer is being kept |
| `/opt/beszel/hub_data` | 6.3 MB | Beszel monitoring hub history |
| `/var/www/admin.corefinite.com/` | 62 KB | `index.html`, `logs.html`, `shopbook.html` — the admin UI, served straight off disk by nginx. Near-identical copies live in `/home/srihari/vaultchat/admin/`, but the deployed `shopbook.html` is 26 days newer and roughly twice the size, so **copy the deployed files** |

### 1.4 The single biggest thing at risk right now

> **`docker compose down -v` deletes `vaultchat_miniodata` — 6.63 GB of user broadcast and media objects with no second copy anywhere on earth.**
>
> Second worst is `vaultchat_pgdata`, which at least has nightly dumps — except see §9.10 for why those dumps are currently local-only.

---

## 2. Containers — 29 running, 0 stopped

### 2.1 Managed by the `vaultchat` compose project (17)

Working dir `/home/srihari/vaultchat`, all `restart: unless-stopped`.

| Container | Image | Up | Created from | **Profile needed** |
|---|---|---|---|---|
| `vaultchat-go-api-1` | `vaultchat-go-api` (local build) | 15 min | yml + prod + **box** | default |
| `vaultchat-caddy-1` | `caddy:2-alpine` | 2 wk | yml + prod | default |
| `vaultchat-postgres-1` | `postgres:16` | 4 wk (healthy) | yml + prod | default |
| `vaultchat-pgbouncer-1` | `edoburu/pgbouncer:v1.23.1-p2` | 6 wk | yml + prod + box | default |
| `vaultchat-redis-1` | `redis:7` | 4 wk | yml + prod + box | default |
| `vaultchat-minio-1` | `minio/minio:latest` | 3 wk | yml + prod | default |
| `vaultchat-coturn-1` | `coturn/coturn:4.6.2` | 9 h | yml | default |
| `vaultchat-valhalla-1` | `gis-ops/docker-valhalla:latest` | 6 wk | yml + prod + box | default |
| `vaultchat-livekit-1` | `livekit/livekit-server:v1.13.5` | 12 d | yml | **`sfu`** |
| `vaultchat-livekit-egress-1` | `livekit/egress:v1.14.0` | 4 wk | yml | **`sfu`** |
| `vaultchat-golive-livekit-1` | `livekit/livekit-server:v1.13.5` | 3 wk | yml + prod | **`golive`** |
| `vaultchat-golive-egress-1` | `livekit/egress:v1.14.0` | 3 wk | yml + prod | **`golive`** |
| `vaultchat-golive-redis-1` | `redis:7` | 3 wk | yml + prod | **`golive`** |
| `vaultchat-kafka-1` | `apache/kafka:3.8.1` | 6 wk | yml + prod + box | **`legacy`** |
| `vaultchat-prometheus-1` | `prom/prometheus:v2.53.0` | 6 wk | yml + prod + box | **`monitoring`** |
| `vaultchat-grafana-1` | `grafana/grafana:11.1.0` | 6 wk | yml + prod + box | **`monitoring`** |

> ### Rebuild trap: compose profiles hide 9 of 17 containers
> Measured on the box:
> ```
> docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml config --services
> -> caddy coturn go-api minio pgbouncer postgres redis valhalla     (8 services)
> ```
> A plain `docker compose up -d` restores **8 of the 17** running containers.
> **Calling (`sfu`), Go-Live (`golive`), Kafka (`legacy`) and monitoring (`monitoring`) all stay down, silently — no error, they simply are not in the plan.**
>
> The correct command is:
> ```
> docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml \
>   --profile sfu --profile golive --profile monitoring --profile legacy up -d
> ```
> Caveat: `--profile legacy` also declares `api` and `fanout-worker` (the retired Node backend), which are **not** running today. Enable `legacy` only if you want Kafka back, and expect to stop those two afterwards.

Declared in compose but not running today: `api`, `fanout-worker`. The images `vaultchat-api`, `vaultchat-stack-api`, `vaultchat-stack-fanout-worker` and `vaultchat-stack-vaultlens-worker` are still on disk but no container uses them. **The vaultlens BullMQ worker is not running.**

### 2.2 NOT managed by the vaultchat compose project — **12 containers**

These are the ones `docker compose down` will not bring back.

| Container | Image | Managed by | What recreates it |
|---|---|---|---|
| **`vaultchat-games`** | `vaultchat-games:latest` | **Nothing — a hand-typed `docker run`** | `/opt/vaultgames/run.sh` recreates the container. **Nothing recreates the image.** See §9.1 |
| **`portainer`** | `portainer/portainer-ce:latest`, `restart: always` | **Nothing — a hand-typed `docker run`** | **Nothing.** No compose file, no script. Mounts `/var/run/docker.sock` rw. |
| `beszel` | `henrygd/beszel:latest` | compose project `beszel`, `/opt/beszel/docker-compose.yml` | that file |
| `jms_postgresql`, `jms_redis`, `jms_web`, `jms_core`, `jms_celery`, `jms_koko`, `jms_lion`, `jms_chen` (8) | `jumpserver/*:v4.10.16-ce`, `postgres:16.10-bookworm`, `redis:7.4.6-bookworm` | compose project `jms`, 9 files under `/opt/jumpserver-installer-v4.10.16/compose/` | the JumpServer installer **plus `/opt/jumpserver/config/config.txt`**, which holds its generated secrets |
| `searxng` | `searxng/searxng:latest` | compose project `searxng`, `/opt/searxng` | that file plus `/opt/searxng/searxng/settings.yml` |

**Count of containers outside the vaultchat compose project: 12.**
**Of those, 2 have no compose file or manifest at all: `vaultchat-games` and `portainer`.**

`vaultchat-games` is production — it is what `games.corefinite.com` serves, it joins `vaultchat_default`, and it writes to the shared Postgres.

---

## 3. Bind mounts — state living outside Docker

### vaultchat project

```
go-api         /home/srihari/vaultchat/secrets/games-notify.pub          -> /run/secrets/games-notify.pub    ro
go-api         /home/srihari/vaultchat/secrets/fcm-service-account.json  -> /run/secrets/firebase-sa.json    ro
go-api         /home/srihari/vaultchat/secrets/games-signing.key         -> /run/secrets/games-signing.key   ro
go-api         /home/srihari/vaultchat/uploads-shared                    -> /data/uploads                    rw   (16K, 0 files — media goes to R2/MinIO)
caddy          /home/srihari/vaultchat/caddy/Caddyfile                   -> /etc/caddy/Caddyfile             ro
caddy          /home/srihari/vaultchat/caddy/public                      -> /srv/public                      ro   (assetlinks.json + legal pages)
livekit        /home/srihari/vaultchat/livekit/livekit.yaml              -> /etc/livekit.yaml                ro
golive-livekit /home/srihari/vaultchat/livekit/golive.yaml               -> /etc/livekit.yaml                ro
coturn         /home/srihari/vaultchat/coturn/turnserver.conf            -> /etc/coturn/turnserver.conf      ro
coturn         /home/srihari/vaultchat/coturn/certs                      -> /etc/coturn/certs                ro   (cert.pem/pkey.pem, owned 65534:65534)
grafana        /home/srihari/vaultchat/monitoring/grafana-datasource.yml -> .../datasources/ds.yml           ro
prometheus     /home/srihari/vaultchat/monitoring/prometheus.yml         -> /etc/prometheus/prometheus.yml   ro
valhalla       /home/srihari/vaultchat/valhalla/custom_files             -> /custom_files                    rw   (9.8 GB — see §1.3)
```

### Outside the vaultchat project

```
portainer   /var/run/docker.sock  -> /var/run/docker.sock   rw   (full Docker control)
beszel      /opt/beszel/hub_data  -> /beszel_data           rw
searxng     /opt/searxng/searxng  -> /etc/searxng           rw
jms_* (8)   /data/jumpserver/{postgresql,core,koko,lion,chen,redis,nginx}/data    rw
jms_* (6)   /opt/jumpserver/config/certs  and  /opt/jumpserver/config/redis/redis.conf
```

**Nothing under `/root` is bind-mounted.** Every bind mount from `/home/srihari` is under `/home/srihari/vaultchat`, so copying `/home/srihari/vaultchat`, `/opt` and `/data/jumpserver` captures every bind-mounted path on the box.

---

## 4. Networks and ports

### Docker networks

```
vaultchat_default   bridge   14 containers (all vaultchat except the 3 host-network ones)
jms_net             bridge   8 jumpserver containers
beszel_default      bridge   beszel
searxng_default     bridge   searxng
bridge (default)    bridge   portainer
host                host     vaultchat-livekit-1, vaultchat-golive-livekit-1, vaultchat-coturn-1
```

The three `network_mode: host` containers are deliberate: RTC has to advertise the host's real address in its ICE candidates.

### Public — reachable from the internet

| Port | Process | Serves |
|---|---|---|
| 22/tcp | sshd | SSH, key-only, fail2ban `sshd` jail active |
| 80, 443/tcp | **nginx, on the host — not Docker** | every HTTPS vhost |
| 443/udp | *no listener* | `iptables -t nat PREROUTING` REDIRECTs UDP/443 to 3478 so TURN works on networks that allow only 80/443. Invisible to `ss` — check rule counters (`iptables -t nat -L PREROUTING -v -n`), not listeners. |
| 3478, 5349 tcp+udp | coturn (host net) | TURN / TURNS |
| 7880, 7881 | livekit-server | calling SFU (7880 ufw-restricted to 172.16/12) |
| 7890, 7891, 7892 | golive livekit-server | Go-Live SFU (7890 ufw-restricted to 172.16/12) |
| 49152–65535/udp, 49160–49200/udp | livekit / coturn | RTP media |
| 2222/tcp | docker-proxy to `jms_koko` | JumpServer SSH gateway |
| 8090/tcp | docker-proxy to `jms_web` | JumpServer web (also proxied via jump.corefinite.com) |
| 19000/tcp | docker-proxy to MinIO | bound `0.0.0.0` but **DROPped in `DOCKER-USER`** (§5) |
| 19092/tcp | docker-proxy to Kafka | bound `0.0.0.0` but **DROPped in `DOCKER-USER`** (§5) |

### Loopback only

`3000` (nothing listening — stale vhost), `3001` grafana, `5432` host Postgres, `6379` host Redis,
`8002` valhalla, `8080` searxng, `8091` beszel, `8095` **caddy**, `8096` **vaultchat-games**,
`9000` portainer, `9999` vaultchat-logs (python), `16379` redis, `16380` golive-redis.

> ### Rebuild trap: nginx terminates TLS, not Caddy
> Caddy is bound to `127.0.0.1:8095` and serves plain HTTP on `:80` inside the container. **Host nginx owns 80/443, holds every certificate, and proxies inward**: to Caddy for `stream.corefinite.com`, and to MinIO (19000) / Grafana (3001) for `api.corefinite.com`.
>
> A rebuild that assumes "Caddy does TLS, like the Caddyfile implies" produces a box with no working HTTPS. **nginx is a first-class, hand-configured component here and none of it is in the repo.**

---

## 5. Host-level state

### Crontabs

```
srihari:  30 2 * * *   /home/srihari/vaultchat-backups/backup.sh >> .../backup.log 2>&1
root:     (empty)
/etc/cron.d/vaultgames-backup:  17 3 * * *  root /opt/vaultgames/backup.sh
/etc/cron.d/certbot:            inert — systemd is present, so certbot.timer takes precedence
/etc/cron.d/{e2scrub_all,sysstat}: distro defaults
/etc/cron.{daily,weekly}: distro defaults only (apport, apt-compat, dpkg, logrotate, man-db, sysstat)
```

`certbot.timer` is the live renewal mechanism (next run 22:51 IST).

### Non-Docker systemd services, running

```
nginx                   owns 80/443 and all TLS termination
postgresql@16-main      host Postgres on 127.0.0.1:5432 — holds only `vaultchat_stale_20260722` (12 MB).
                        The app uses the CONTAINER Postgres, not this one.
redis-server            host Redis on 127.0.0.1:6379, password-protected. See §10.
fail2ban                sshd jail
beszel-agent            /opt/beszel-agent/beszel-agent, secrets inline in the unit
vaultchat-logs          python3 /home/srihari/vaultchat/admin/logserver.py on 127.0.0.1:9999
docker, containerd, cron, atd, unattended-upgrades, sysstat, mdmonitor, multipathd, rsyslog, ssh
```

### Custom systemd units — all must be recreated by hand

```
/etc/systemd/system/vaultchat-firewall.service         -> /usr/local/sbin/vaultchat-firewall.sh
/etc/systemd/system/vaultchat-docker-firewall.service  -> /usr/local/sbin/vaultchat-docker-firewall.sh
/etc/systemd/system/vaultchat-logs.service             -> admin/logserver.py, EnvironmentFile=/etc/vaultchat-logs.env
/etc/systemd/system/beszel-agent.service               (contains KEY + TOKEN inline)
/etc/systemd/system/coturn.service -> /dev/null        (masked on purpose: host coturn is disabled in favour of the container)
```

**`/usr/local/sbin/vaultchat-firewall.sh` and `vaultchat-docker-firewall.sh` are load-bearing and exist only on this box** — I found no copy anywhere in the repo tree. Between them they do two things neither Docker nor ufw will do:

1. `DOCKER-USER` DROP rules for ports `8090 14000 15432 16379 19000 19001 19092`, matched on `conntrack --ctorigdstport`. Docker's DNAT runs *before* ufw's INPUT chain, so `ufw deny` has no effect on published container ports (the script's own comment records that Redis stayed reachable with a ufw DROP in place). Also, by the time `DOCKER-USER` sees the packet, DNAT has already rewritten `--dport` to the container's internal port, which is why `--ctorigdstport` is required and a plain `--dport` match silently does nothing. **Without these rules MinIO (19000) and Kafka (19092) are open to the internet.**
2. `nat PREROUTING` REDIRECT UDP/443 to 3478, on **both** `iptables` and `ip6tables` — coturn serves IPv6 too. Without it, users on restrictive networks gather no relay candidate and calls quietly fail to connect.

### UFW

Active, `default deny (incoming)`, `iptables -P INPUT DROP`.
Open to the world: 22/80/443 tcp, 443/udp, 3478 + 5349 tcp/udp, 7881 + 7891 tcp, 7882 + 7892 udp, 49152–65535/udp, 49160–49200/udp.
Restricted: 7880 and 7890 to `172.16.0.0/12`; 6432/tcp to `172.28.0.0/16` and `172.17.0.0/16`.

### Hand-edited `/etc` that would be lost

```
/etc/docker/daemon.json                 live-restore true; json-file log rotation 10m x 3
/etc/sysctl.d/99-vaultchat-media.conf   net.core.rmem_max = net.core.wmem_max = 5000000
                                        (LiveKit/coturn UDP buffers; without it the kernel drops RTP
                                         under load and calls degrade with nothing in any log)
/etc/nginx/nginx.conf                   adds `map $http_upgrade $connection_upgrade` for WS upgrade
/etc/nginx/vaultchat-stream-proxy.conf  shared proxy headers for the stream vhost
/etc/nginx/sites-available/  (8 files)  + sites-enabled (7 entries)
/etc/letsencrypt/renewal-hooks/deploy/coturn.sh
/usr/local/sbin/vaultchat-firewall.sh, vaultchat-docker-firewall.sh
/etc/vaultchat-logs.env
```

**`.bak` / `.save` files found in `/etc` (6):** `/etc/apt/preferences.d.save`, `/etc/redis/redis.conf.save`, `/etc/turnserver.conf.save`, `/etc/.resolv.conf.systemd-resolved.bak`, `/etc/nginx/sites-available/vaultchat.bak.1780248083`, `/etc/nginx/sites-available/vaultchat.bak.pm2`. All superseded; none needed.

Stale and safe to drop: `/etc/pgbouncer/{pgbouncer.ini,userlist.txt}` — pgbouncer runs as a container with **no mounts**, configured purely by environment, so the host copy is dead config. Likewise `/etc/turnserver.conf` (coturn is containerised) and `/etc/redis/redis.conf` if nothing turns out to use the host Redis.

### pm2

**None running.** `pm2` is not on PATH for srihari and `/home/srihari/.pm2/` contains no `dump.pm2`. The Node/pm2 era is over; `/etc/nginx/sites-available/vaultchat.bak.pm2` is its fossil.

---

## 6. TLS and DNS

**Mechanism: certbot with `authenticator = nginx` and `installer = nginx`, driven by `certbot.timer`.**
**Storage: `/etc/letsencrypt/` — 572 KB, containing the ACME account key and 8 lineages.**

| Lineage | Domains on the cert | Expires |
|---|---|---|
| `api.corefinite.com` | api + stream + turn | 2026-11-29 (77 d) |
| `turn.corefinite.com` | turn | 2026-12-12 (89 d) |
| `games.corefinite.com` | games | 2026-11-13 (61 d) |
| `admin.corefinite.com` | admin | 2026-11-08 (55 d) |
| `monitor.corefinite.com` | monitor | 2026-11-14 (62 d) |
| `portainer.corefinite.com` | portainer | 2026-11-14 (62 d) |
| `jump.corefinite.com` | jump | 2026-11-14 (62 d) |
| `teleport.corefinite.com` | teleport | **2026-09-15 — one day** and `teleport.corefinite.com` **no longer resolves**, so it can never renew. Delete this lineage during the rebuild or it fails loudly forever. |

> ### Rate-limit risk: real, and worth planning around
> Let's Encrypt allows **5 duplicate certificates per identical domain set per 7 days** (plus 50 new certs per registered domain per week). Issuing all 8 lineages once on a fresh box is fine. The danger is an *iterated* rebuild: rebuild, something is wrong, rebuild again. On the sixth attempt `api.corefinite.com` hits the duplicate-certificate limit and **the API has no HTTPS for a week.**
>
> **Mitigation: `tar czf letsencrypt.tgz /etc/letsencrypt` before the wipe and restore it onto the new box.** Restoring the directory means zero issuances and zero risk. Use `certbot --dry-run` for any experimentation.

**Deploy hook `/etc/letsencrypt/renewal-hooks/deploy/coturn.sh`** copies the renewed `turn.corefinite.com` cert into `/home/srihari/vaultchat/coturn/certs/` as `cert.pem`/`pkey.pem`, `chown 65534:65534`, `chmod 644`/`640`, then `docker restart vaultchat-coturn-1`. coturn reads its cert only at startup, so without this hook it keeps serving the old certificate until it expires — and the failure is silent, because ICE simply moves to another candidate and calls merely get worse. The ownership matters too: root-owned 640 is unreadable to the container's `nobody` user and coturn then starts with **no TLS listener at all**. This hook ran today (cert mtime 08:20, coturn uptime 9 h). **It must be recreated.**

### DNS, resolved against 1.1.1.1

```
api.corefinite.com        -> 65.21.229.167                      direct
turn.corefinite.com       -> 65.21.229.167                      direct (must stay direct — TURN cannot be proxied)
games.corefinite.com      -> 65.21.229.167                      direct
monitor.corefinite.com    -> 65.21.229.167                      direct
portainer.corefinite.com  -> 65.21.229.167                      direct
jump.corefinite.com       -> 65.21.229.167                      direct
stream.corefinite.com     -> 104.21.51.217 / 172.67.186.181     Cloudflare proxy
admin.corefinite.com      -> 104.21.51.217 / 172.67.186.181     Cloudflare proxy
corefinite.com            -> 104.21.51.217 / 172.67.186.181     Cloudflare proxy
teleport.corefinite.com   -> NXDOMAIN
```

DNS is hosted at Cloudflare. **If the rebuild lands on a new IP, six direct A-records need updating**, and the two proxied hostnames need their Cloudflare origin updated instead. **Cloudflare account credentials are not on this box — unknown where they live.**

---

## 7. External dependencies

| Service | Used for | Credential location | Does a rebuild break it? |
|---|---|---|---|
| **Cloudflare R2** (`7fd1208c…r2.cloudflarestorage.com`) | VaultBeam attachments, media, and the **encrypted off-site DB backups** under the `db-backups/` prefix | `VAULTBEAM_S3_*` in `vaultchat-backend/.env`; a second set is **inline in `docker-compose.box.yml`** as `S3_*` (bucket `vaultchat-media`) | No, if the env files carry over. **But the off-site upload has been failing for 7 nights — see §9.10.** |
| **MinIO** (self-hosted, in-stack) | `vaultchat-broadcast` 5.8 GB + `vaultchat-media` 521 MB | container env | **Yes, if `vaultchat_miniodata` is not carried over. No remote copy exists.** |
| **LiveKit** ×2 (self-hosted SFU) | 1:1 and group calls (`livekit`), Go-Live (`golive-livekit`) | `LIVEKIT_API_KEY/SECRET` and `GOLIVE_LIVEKIT_*` in `.env`; configs in `livekit/livekit.yaml` and `livekit/golive.yaml` | No — self-hosted; the keys just have to stay consistent with already-issued client tokens |
| **FCM / Firebase** (project `vaultchatprod01`) | Push, including calls-when-killed | `secrets/fcm-service-account.json`, referenced by `FIREBASE_SERVICE_ACCOUNT_FILE` | No, if copied. Reissuable from the Firebase console if lost. |
| **Valhalla** (self-hosted) | In-app turn-by-turn navigation, `127.0.0.1:8002` | none | Not broken — but 9.8 GB of tiles rebuild over hours unless copied |
| **External games server** | `vaultchat-games`, serving `games.corefinite.com` | `/opt/vaultgames/keys/*` and `secrets/games-*` | **Yes — and this is the worst of them. See §9.1** |
| **Resend** (SMTP) | `EMAIL_FROM=VaultChat <noreply@corefinite.com>` | `RESEND_API_KEY` in both `.env` files | No, if env copied |
| **Sentry** | Error reporting | `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE` | No |
| **Ollama** | `OLLAMA_URL=http://localhost:11434` — **nothing is listening on 11434 and no Ollama process exists.** The AI path points at a host that is not there. | — | Already broken; a rebuild changes nothing |
| **SearXNG** (self-hosted) | `SEARXNG_URL=http://localhost:8080` | `/opt/searxng/searxng/settings.yml` | Yes, if the searxng stack is not rebuilt |
| **Giphy / Tenor / Klipy** | GIF search | `GIPHY_KEY`, `TENOR_KEY`, `KLIPY_KEY` in `vaultchat-backend/.env` | No, if env copied |
| **Beszel hub** (`monitor.corefinite.com`) | Host monitoring | key + token inline in `beszel-agent.service` | The agent must be re-registered if the unit is lost |
| **JumpServer** (`jump.corefinite.com`) | Bastion | `/opt/jumpserver/config/config.txt` | Yes, if that config is not copied |

---

## 8. The `/home/srihari/vaultchat` directory

```
branch:              hetzner-deploy
HEAD:                c9c3f24  feat(shopbook): put the shop's identity on the bill, and restyle it
vs origin:           0 ahead, 2 BEHIND   (origin/hetzner-deploy has 2 commits not on this box)
remote:              https://github.com/srihari8204/VaultChat.git
git status --short:  254 files
```

(Run as srihari, `git status` also warns `could not open directory 'secrets/': Permission denied` — that directory is 0700 root.)

The 254 dirty files are not noise. They include `docker-compose.yml`, `docker-compose.prod.yml`, `caddy/Caddyfile`, `coturn/turnserver.conf`, `livekit/livekit.yaml`, and roughly 200 files under `vaultchat-backend-go/` — including **deletions** (`internal/routes/ai.go`, `internal/routes/vaultlens.go`) that exist only as uncommitted working-tree state.

> **The running production configuration is uncommitted.** A fresh `git clone` on the new box produces a *different* stack than the one running today, and it is 2 commits divergent from origin in the other direction as well.
>
> **Archive the working tree — `tar czf vaultchat-worktree.tgz /home/srihari/vaultchat` — do not re-clone.**

### Stray `*.bak*` / `*.old` / `*.orig` files inside the tree: **23**

```
docker-compose.yml.bak-redismem
docker-compose.yml.bak-livekit
docker-compose.yml.bak-fcm
docker-compose.yml.bak-egress
docker-compose.yml.bak-20260809-202744
docker-compose.prod.yml.bak-livekitfix
docker-compose.prod.yml.bak-webhook
caddy/Caddyfile.bak-232246
coturn/turnserver.conf.bak-2026-08-10
coturn/turnserver.conf.bak-quota
livekit/livekit.yaml.bak
livekit/livekit.yaml.bak-webhook
livekit/livekit.yaml.bak-redis
vaultchat-backend-go/internal/routes/calls.go.bak-namefix
vaultchat-backend-go/internal/routes/call_sessions.go.bak-namefix
vaultchat-backend-go/internal/routes/namecols_test.go.bak-namefix
vaultchat-backend-go/internal/routes/chats_helpers.go.bak
vaultchat-backend-go/internal/routes/shopbook.go.bak-20260830T020500Z
vaultchat-backend/.env.bak-pre-turnhost-20260819T103136Z
vaultchat-backend/routes/user.js.bak-20260912-141510
vaultchat-backend/routes/chats.js.bak-20260912-141510
vaultchat-backend/migrate.js.bak-20260912-141510
vaultchat-backend/migrations/127_refresh_token_lookup.sql.bak-predeploy
```

There is a much larger pile one level up in `/home/srihari` itself — roughly 40 loose files and 12 backup directories: `call_sessions.go.*` (6 variants), `vaultbeam.go.backup-*` (2), `main.go.backup-*`, `golive.yaml.bak-*`, `Caddyfile.bak-*`, `livekit.yaml.bak.*`, `deploy-backup-*` (3 dirs), `vc-bak-*` (3 dirs), `golive-*` (3 dirs), `vaultchat-api.OLD/`, `migrate-run/`, `deploy-stage/`, and two `vaultchat-backend-go.backup.*.tgz`. None of it is needed for a rebuild.

**But three of those loose files contain live credentials** — `dotenv.bak.20260831-233935`, `.env.backup-20260815-retention`, `env-backup-20260816T225239Z.bak`. Destroy them with the old disk; do not leave them on a decommissioned box.

---

## 9. WOULD BE SILENTLY LOST

Things that exist only because someone once ran a command by hand, which no file in the repo would recreate.

**9.1 — `vaultchat-games`: the container AND its source code.**
Created by a bare `docker run`, not compose. `/opt/vaultgames/run.sh` recreates the *container*, and its comments are explicit about why the script exists: the run command is fifteen flags long, and dropping `GAMES_DB_URL` makes it "quietly fall back to the dev file store, losing every player on the next restart with no error anywhere." But the **image** `vaultchat-games:latest` was built on this box from `/opt/vaultgames/go-server`, which has **no upstream repository**. Fourteen `rollback-*` tags of it exist here and nowhere else. **Copy `/opt/vaultgames/` wholesale — it is the only copy of a production service.**

**9.2 — `portainer`.** Hand-run `docker run`, `restart: always`, `/var/run/docker.sock` mounted read-write. No compose file, no script, no note. It will simply not come back, and `portainer.corefinite.com` will 502.

**9.3 — The two firewall scripts and their systemd units.** Without them, MinIO (19000) and Kafka (19092) become internet-reachable — ufw cannot stop them, because Docker's DNAT precedes ufw's INPUT chain — and TURN-over-UDP-443 stops working for users on restrictive networks. Both failures are invisible: nothing shows in `ss`, and calls just get worse.

**9.4 — The certbot coturn deploy hook.** See §6. Silent TURNS expiry roughly 60 days after the rebuild.

**9.5 — The entire nginx layer.** 8 vhosts in `sites-available`, 7 links in `sites-enabled`, the `map $http_upgrade` block in `nginx.conf`, and `vaultchat-stream-proxy.conf`. None of it is in the repo, and without it there is no TLS at all (§4).

**9.6 — `/etc/sysctl.d/99-vaultchat-media.conf`.** Without it LiveKit logs "UDP receive buffer is too small for a production set-up" and the kernel drops RTP under load.

**9.7 — The compose profiles.** 9 of 17 containers do not return without explicit `--profile` flags. See §2.1.

**9.8 — The uncommitted working tree.** 254 modified files, including every service config. See §8.

**9.9 — Grafana dashboards.** Only the datasource is provisioned from a file. Anything built in the UI lives in `vaultchat_grafanadata` and nowhere else.

**9.10 — The off-site backup chain is CURRENTLY BROKEN.**
`/home/srihari/vaultchat-backups/backup.log` shows the local dump succeeding every night, and then:

```
2026-09-05  off-site ok
2026-09-06  WARNING: off-site copy FAILED — this backup exists only on this box
2026-09-07  WARNING …
2026-09-08  WARNING …
2026-09-09  WARNING …
2026-09-10  WARNING …
2026-09-11  WARNING …
2026-09-12  WARNING …
```

**Seven consecutive nights. The newest restore point that exists anywhere other than this box is 2026-09-05.**

The go-api container does still carry all six `VAULTBEAM_S3_*` variables, so this is not a missing-variable bug. The start date lines up exactly with the R2 token outage recorded on 2026-09-06, which points at revoked or expired R2 credentials — **but I did not confirm that, because verifying it means making an R2 API call, and this inventory was taken strictly read-only. Treat the cause as unconfirmed.**

**Before the rebuild: take a fresh dump and copy it off the box by hand. Do not assume R2 holds a current one.**

**9.11 — The `.offsite-key` paradox.** The passphrase for the R2 backups is stored on the very machine those backups exist to survive. The script prints it once, at creation, and warns about exactly this. Wipe the box without copying `/home/srihari/vaultchat-backups/.offsite-key` and every `.enc` object in R2 becomes permanently unreadable.

**9.12 — Two orphan databases.** Host Postgres holds `vaultchat_stale_20260722` (12 MB); the container Postgres holds `vaultchat_authtest` (17 MB). Neither is referenced by any running config I found. **unknown** whether either is still wanted — dump both before the wipe and decide afterwards.

**9.13 — Sizing note.** There is 71.33 GB of Docker build cache on the box. It is not data; it is mentioned only so nobody mistakes it for data when planning the copy. Actual state to move: ~21 GB of `/var/lib/docker` (6.6 GB of it the MinIO volume), ~11 GB of `/home/srihari` (9.8 GB of it Valhalla tiles), 707 MB of `/data`, 31 MB of `/opt`, 572 KB of `/etc/letsencrypt`.

---

## 10. What I could not determine

- **Whether any Kafka topic is a source of truth.** `vaultchat_kafkadata` is 79 MB, Kafka sits in the `legacy` profile, and go-api runs without it in the default profile — so it is probably transient, but I did not enumerate topics.
- **Whether the host `redis-server` (127.0.0.1:6379, password-protected) still has a consumer.** `.env` on disk says `REDIS_HOST=127.0.0.1`, but the containers run on the compose network where that resolves to themselves, and `vaultchat-redis-1` is published on 16379. I did not trace which instance actually serves go-api.
- **Which Grafana dashboards exist.** Enumerating them requires logging in.
- **Where the Cloudflare DNS credentials live.** Not on this box.
- **Whether `/var/www/admin.corefinite.com/*.html` differs materially from the repo copies in `admin/`.** The deployed `shopbook.html` is 26 days newer and roughly twice the size, so assume it does and copy the deployed files.
- **The exact cause of the R2 off-site upload failures starting 2026-09-06** (§9.10) — confirming it requires a write-path call I deliberately did not make.
- **Whether `vaultchat_authtest` and `vaultchat_stale_20260722` are still wanted** (§9.12).
