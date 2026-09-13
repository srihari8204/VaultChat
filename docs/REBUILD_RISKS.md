# REBUILD_RISKS.md

What breaks if `65.21.229.167` is torn down and rebuilt from this repository — ranked worst first,
with an emphasis on the failures **nobody would notice at cutover**.

Method: read-only SSH against the live box on 2026-09-13, compared against this working tree.
Everything below was measured, not inferred, except where it says "could not determine".

**Headline answers**

1. **Worst silent breakage:** `vaultchat-backend/.env` on the box holds `VAULTCHAT_MASTER_KEY` and
   `VAULTCHAT_LOOKUP_PEPPER`. It is `.gitignore`d and exists nowhere else. `SELECT count(email) FROM users`
   is **0** — every user's email, phone, name and DOB lives only in the `*_cipher` columns, and login
   matches on `phone_lookup` / `email_lookup`, which are peppered hashes. Lose that file and the Postgres
   volume can survive perfectly while every account becomes unidentifiable and unrecoverable. The rebuild
   comes up green, health checks pass, and **no existing user can ever log in again.**
2. **Does the live schema match what the migrations produce? Yes.** The ledger is at `130`, matching
   `vaultchat-backend/migrations/130_screen_usage.sql`, and a full object diff shows no table, view or
   function on the box that a migration does not create. The only extras are runtime artifacts
   (`message_bodies_YYYYMMDDHH` hourly partitions) and `schema_migrations` itself. **The schema is clean.
   The things migrations do *not* create — roles, GRANTs, and a second database — are the problem (see #6, #7).**
3. **ACME/certificates: Caddy is not the TLS terminator and holds no ACME state at all.** Host `nginx`
   owns `:80`/`:443` and terminates TLS from `/etc/letsencrypt`, managed by `certbot.timer`. Caddy runs
   behind it on `127.0.0.1:8095`, has **no `/data` volume of any kind** (24 KB in the container's writable
   layer; `/data/caddy/certificates` does not exist). So the Let's Encrypt rate-limit risk is real but it
   lives in `/etc/letsencrypt`, not in a Docker volume. Details and the exact domain list in #8.

---

## 1. `vaultchat-backend/.env` — the master key and the lookup pepper

**Where it is:** `/home/srihari/vaultchat/vaultchat-backend/.env` (mode 0600, owner `srihari`).
It is matched by `.gitignore` twice (`vaultchat-backend/.env` and `*.env`), so it has never been committed.
`docker-compose.yml` pulls it in via `env_file: ./vaultchat-backend/.env` with `required: false` —
meaning **a rebuild without it starts cleanly and silently.**

Keys that exist ONLY in this file (verified absent from `docker-compose*.yml`, the top-level `.env`, and
this repo):

| Key | Consequence of loss |
|---|---|
| `VAULTCHAT_MASTER_KEY` | All `users.*_cipher`, `photo_key_cipher` etc. permanently undecryptable. 17 of 18 user rows affected. |
| `VAULTCHAT_LOOKUP_PEPPER` | `phone_lookup` / `email_lookup` can never be recomputed → **no user can be found at login.** |
| `TURN_HOST6` (`2a01:4f9:6a:1c5c::2`) | IPv6-only clients lose the TURN relay. |
| `VAULTBEAM_S3_*` | VaultBeam transfers break, **and the off-site backup upload breaks** (see #2). |
| `GIPHY_KEY`, `TENOR_KEY`, `KLIPY_KEY` | GIF pickers return empty results, no error. |
| `JWT_SECRET` | Every issued token invalidated — loud, so this one you *would* notice. |

**How it presents:** the stack comes up healthy. Existing installs show "account not found" or a silent
login failure. Profile screens render blank names. It looks like a client bug or a bad migration.
There is no log line that says "the pepper changed" — from the server's point of view the hashes simply
match no row.

**Before the rebuild:** copy this file off the box into a password manager / offline store.
`VAULTCHAT_MASTER_KEY` and `VAULTCHAT_LOOKUP_PEPPER` in particular must be treated like the release
keystore — they cannot be regenerated after the fact.

---

## 2. `.offsite-key` — the off-site backups are encrypted with a passphrase that exists only on the box

**Where it is:** `/home/srihari/vaultchat-backups/.offsite-key` (65 bytes, mode 0600).
`backup.sh` runs `openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:$KEYFILE` before uploading to R2.

Two compounding problems:

- **The key is not in the repo.** Lose it and every `.enc` object in R2 is noise. You would believe you
  have 14 days of off-site backups right up until the moment you need one.
- **`backup.sh` itself is not in the repo either**, despite its own header saying *"It lives here so the
  repo can rebuild the box."* `find . -name backup.sh` in this working tree returns nothing. The script,
  the cron entry (`srihari`'s crontab, `30 2 * * *`) and the key are all box-only state.

The off-site upload also reads its R2 credentials at runtime via
`docker exec vaultchat-go-api-1 printenv VAULTBEAM_S3_*`. If #1 is lost, backups keep running and keep
printing `WARNING: off-site copy FAILED` into a log nobody reads — the code deliberately does not treat
that as fatal.

**How it presents:** invisible until a restore is attempted, at which point it is total.

**Before the rebuild:** copy `.offsite-key` off-box, commit `backup.sh` to the repo, and
**test-decrypt one R2 object now**, before anything is torn down.

---

## 3. `docker-compose.box.yml` — R2 credentials, untracked, and media silently reverts to MinIO

**Where it is:** `/home/srihari/vaultchat/docker-compose.box.yml`, mode 0600, **untracked in git**.
It is one of the three overlay files `vaultchat-go-api-1` was created from. It supplies:

```
S3_ENDPOINT / S3_PUBLIC_ENDPOINT  →  https://<acct>.r2.cloudflarestorage.com
S3_ACCESS_KEY / S3_SECRET_KEY     →  the R2 credentials
S3_BUCKET                         →  vaultchat-media
MESSAGE_BODIES                    →  "1"
caddy.ports / go-api.ports        →  !override
```

Without it, `docker-compose.yml` falls through to its own defaults:

```yaml
S3_ENDPOINT: ${S3_ENDPOINT:-http://minio:9000}
S3_ACCESS_KEY: ${S3_ACCESS_KEY:-${MINIO_USER:-vaultchat}}
S3_SECRET_KEY: ${S3_SECRET_KEY:-${MINIO_PASS:-vaultchat_dev_secret}}
```

**How it presents — this is the nasty part.** New uploads work fine: they go to MinIO with dev
credentials and read back correctly. **Every attachment already in R2 becomes a broken image**, because
presigned URLs are now signed for the wrong endpoint with the wrong keys. There are 377 rows in
`attachments`. Users see old photos and voice notes fail to load while new ones are fine — which reads
like a CDN blip, not a configuration loss. `MESSAGE_BODIES` also silently drops to its default.

**Before the rebuild:** copy `docker-compose.box.yml` off-box, and decide whether these belong in the
repo as `${VAR}` references with values in `vaultchat-backend/.env`, so there is one secret file
instead of two.

---

## 4. LiveKit webhooks: a placeholder key in the repo, and nothing listening on `:14000`

Two independent faults producing the same symptom, so fixing one will not fix it.

**(a) The repo ships a placeholder.** `livekit/livekit.yaml` in this working tree contains:

```yaml
webhook:
  api_key: REPLACE_WITH_LIVEKIT_API_KEY
```

The live box has the real value, `APIEQDUXFM32xZx`. `livekit/golive.yaml` is **untracked entirely** and
carries `api_key: APIGPParpw8RsaL`. LiveKit reads these files **verbatim with no `${VAR}` expansion** —
the file's own comments say so. Rebuild from the repo and LiveKit signs every webhook with the literal
string `REPLACE_WITH_LIVEKIT_API_KEY`, which go-api's signature check rejects.

Also drifted in the same file: `room.max_participants` is `100` in the repo, `200` on the box.

**(b) `127.0.0.1:14000` genuinely has no listener right now.** Confirmed: `ss -lntp | grep 14000`
returns nothing, and `docker ps` shows `vaultchat-go-api-1 … 4000/tcp` with no published port.
`docker-compose.prod.yml` maps `"127.0.0.1:14000:4000"`, but `docker-compose.box.yml` (#3) then does
`ports: !override []` and wipes it. Both SFUs post to a dead port:

- `livekit/livekit.yaml` → `http://127.0.0.1:14000/internal/livekit/webhook`
- `livekit/golive.yaml`  → `http://127.0.0.1:14000/internal/golive/webhook`

**How it presents:** calls connect and media flows — the webhook is not on the media path. What breaks
is everything *after*: `room_finished` / `participant_left` never arrive, so call records never close
and duration/participant state is wrong; `egress_ended` never arrives, so broadcast recordings are never
registered; `golive_reaper`'s host-disconnect grace never fires from the webhook side.
**This is already broken in production today.**

**Before the rebuild:** parameterise the two `api_key` values (or at minimum commit the real
`golive.yaml` alongside `livekit.yaml`), and decide deliberately whether `:14000` should be published.
Fix (b) while the box still exists, so you have a known-good baseline to compare against.

---

## 5. Valhalla: 9.8 GB of routing tiles in an untracked bind mount

**Where it is:** `/home/srihari/vaultchat/valhalla/custom_files` — a **bind mount, not a volume**, and
the `valhalla/` directory is **untracked in git**. Contents: `india-latest.osm.pbf`, `valhalla_tiles/`,
`valhalla_tiles.tar`, `valhalla.json`, `file_hashes.txt`. Total 9.8 GB.

**How it presents:** `docker compose up` starts the Valhalla container against an empty `custom_files`.
The container is "up" and healthy. Turn-by-turn navigation (`/nav/route`, `openNavigation.ts`) returns
no route — or the container spends hours silently rebuilding tiles from an OSM extract it no longer has,
which means re-downloading `india-latest.osm.pbf` and a multi-hour build on a box that is also serving
Postgres.

**Before the rebuild:** `tar` the `valhalla/` directory off-box, or at minimum archive
`valhalla_tiles.tar` and `india-latest.osm.pbf`. Budget hours, not minutes, if you do not.

---

## 6. The RLS roles and their GRANTs are hand-run, not migrated

Live roles — **none of which any migration creates**. `grep -liE 'create +role|create +user'` across all
131 files in `vaultchat-backend/migrations/` returns nothing:

```
vaultchat          SUPERUSER  BYPASSRLS   ← what everything actually connects as today
vaultchat_app      NOSUPERUSER NOBYPASSRLS
vaultchat_sys      NOSUPERUSER BYPASSRLS
vaultchat_authapp  NOSUPERUSER
vaultchat_authsys  BYPASSRLS
vaultgames         (owns the vaultgames database — see #7)
```

`vaultchat_app` carries per-table `SELECT/INSERT/UPDATE/DELETE` across the whole schema. Those grants
come from `scripts/rls-roles.sql`, which **is** in this repo but is **not a migration** — it is run by
hand with `-v app_pass=… -v sys_pass=…`, and those passwords live only in
`/root/rls-role-passwords.txt`. Only four migrations mention `vaultchat_app` at all (002, 003, 004, 008);
grants for every table added since exist purely because someone re-ran that script.

Mitigating fact, stated plainly: **`go-api` currently connects as `DB_USER=vaultchat`** (the superuser),
so today the roles are inert and losing them would not break the running app. The risk is the reverse —
a rebuild silently drops them, and then at some later date the RLS flip described in `scripts/rls-flip.md`
fails in a way that looks like a code bug.

`/root/rls-role-passwords.txt` is box-only.

Two things checked and found **safe**: pgbouncer's `[databases]` entry uses `auth_user=vaultchat`, so it
looks hashes up in Postgres rather than needing them in `userlist.txt`; and its `pgbouncer.ini` /
`userlist.txt` are both auto-generated from env at container start (no mounts at all). pgbouncer is
genuinely stateless and rebuilds correctly.

**Before the rebuild:** capture `/root/rls-role-passwords.txt`, and consider promoting `rls-roles.sql`
into the migration sequence so the roles become reproducible.

---

## 7. The games server: an external binary, a second database, and a container-name-pinned DSN

Three separate pieces of box-only state:

- **`/opt/vaultgames/`** — `go-server/` (the running binary), `go-server-new.tar.gz`, `keys/`, `run.sh`,
  `backup.sh`, `patch/`. **There is no source for this in the repo.** A rebuild from git produces no
  games server at all.
- **The `vaultgames` Postgres database**, owned by role `vaultgames`. No migration creates either. It
  holds every player balance, rating and friend list. Its only backup is
  `/etc/cron.d/vaultgames-backup` → `/opt/vaultgames/backup.sh`, writing to `/opt/vaultgames/backups`
  **locally only — this one is never copied off-site.**
- **`vaultchat-games` is not compose-managed.** It carries no compose project labels; it was started by
  `/opt/vaultgames/run.sh`, and its DSNs are pinned to **container names**:
  `postgres://vaultgames:…@vaultchat-postgres-1:5432/vaultgames` and
  `redis://vaultchat-redis-1:6379/5`. Those names hold only as long as the compose project stays named
  `vaultchat` — i.e. as long as the stack directory keeps that basename. Rebuild into a directory named
  anything else and the games server stops resolving its database, with a plain DNS failure in a
  container nobody is watching.

**How it presents:** `games.corefinite.com` 502s, or the in-app games tile spins forever. Player balances
are gone with no error anywhere in the VaultChat logs, because it is a different process writing a
different database.

**Before the rebuild:** archive `/opt/vaultgames` whole (including `keys/`), take a fresh
`pg_dump -d vaultgames` **off-box**, and record the exact compose project name those container names
depend on.

---

## 8. `/etc/letsencrypt` and the certbot deploy hook

**Where TLS actually lives:** host `nginx` (7 vhosts enabled), certs under `/etc/letsencrypt/live`,
renewed by `certbot.timer` (last run 2026-09-13 08:20, next 22:51).
**Caddy holds no ACME state and issues nothing.**

Nine lineages on the box, plus the ACME account key:

```
admin.corefinite.com      api.corefinite.com        games.corefinite.com
jump.corefinite.com       monitor.corefinite.com    portainer.corefinite.com
teleport.corefinite.com   turn.corefinite.com
```

(`stream.corefinite.com` is Cloudflare-proxied and has no local lineage — CF terminates it.)

**Rate-limit exposure.** Let's Encrypt allows 5 duplicate certificates per exact name-set per week and
50 new orders per registered domain per week. Nine lineages under one registered domain
(`corefinite.com`) issued in one go sits comfortably inside 50/week, so a *single clean* rebuild
succeeds. **The danger is a rebuild you have to retry.** Each failed-then-retried issuance for the same
name burns one of five weekly duplicates, and `api.corefinite.com` is exactly the name you will be
retrying — it is what the mobile app points at. Three or four passes debugging an nginx config with
`certbot --nginx` in the loop leaves `api.corefinite.com` rate-limited for up to a week, during which
**every installed client fails TLS and the app is simply down.** There is no partial degradation here.

**Also lost:** `/etc/letsencrypt/renewal-hooks/deploy/coturn.sh`, which is **not in this repo** — a grep
for `RENEWED_LINEAGE` across `scripts/ docs/ nginx/ caddy/` returns nothing. It copies the renewed
`turn.corefinite.com` cert into `coturn/certs/`, chowns it to `65534`, and restarts the coturn container.
Its own comments spell out the failure mode: coturn reads its cert only at startup, so without the hook
the TURN certificate expires ~60 days after issue and **every TURNS handshake fails silently** — ICE
just moves to another candidate and calls get worse rather than breaking, so nothing alerts.

`coturn/certs/` is a bind mount whose contents are `.gitignore`d (the repo carries only a `.gitignore`),
so the certs are box-only too.

**Before the rebuild:** `tar -czf letsencrypt.tgz /etc/letsencrypt` and **restore it into the new box
before nginx first starts**, so certbot finds valid lineages and issues nothing. Copy `coturn.sh` into
the repo. If you must re-issue, use `--dry-run` against the staging endpoint first — staging has its own,
far looser, limits.

---

## 9. `172.20.0.1` is hardcoded, and the subnet is not pinned

`go-api` reaches both host-networked SFUs through the Docker bridge gateway:

```
LIVEKIT_HTTP_URL=http://172.20.0.1:7880
GOLIVE_LIVEKIT_HTTP_URL=http://172.20.0.1:7890
```

`vaultchat_default` is currently `172.20.0.0/16`, gateway `172.20.0.1` — **assigned by Docker from its
free pool. `docker-compose.yml` declares no `ipam` block**, so the subnet on a rebuilt box depends
entirely on which networks exist and in what order they were created. The box already carries evidence
this has moved: ufw rules 7 and 8 still allow `6432/tcp` from `172.28.0.0/16` and `172.17.0.0/16`,
neither of which is the current subnet.

**How it presents:** calls and Go Live still *signal* fine — that path goes through Caddy over the
compose network by service name. What fails is every server-side LiveKit **HTTP API** call: room
creation, participant listing, egress start/stop, all timing out against an address that no longer
exists. Group calls never start; broadcasts die in "starting".

Lower-severity pins found alongside: `livekit/livekit.yaml` hardcodes `node_ip: 65.21.229.167`
(deliberate and documented, but it is a per-box value the repo carries), and `golive-egress` uses
`ws://host.docker.internal:7890` via `extra_hosts: host-gateway`, which is portable.

**Before the rebuild:** either declare an explicit `ipam` subnet for `vaultchat_default` in
`docker-compose.yml`, or replace the gateway IP with `host.docker.internal` — the
`extra_hosts: host-gateway` mapping is already present on Caddy and could be added to go-api.

**Grafana datasource UID — checked, and it is fine.** `monitoring/grafana-datasource.yml` pins
`uid: prometheus` explicitly, with a comment saying why. Prometheus targets use the service name
`go-api:4000`, not an IP. Neither is a rebuild hazard.

---

## 10. Image tags: the repo would downgrade LiveKit by five minor versions

| Service | Repo `docker-compose.yml` | Actually running |
|---|---|---|
| `livekit` | `livekit/livekit-server:v1.8` | **v1.13.5** |
| `golive-livekit` | `livekit/livekit-server:v1.8` | **v1.13.5** |
| `livekit-egress` / `golive-egress` | `${LIVEKIT_EGRESS_VERSION:-v1.8.4}` | **v1.14.0** |
| `minio` | `minio/minio:latest` | floating — a rebuild pulls whatever `latest` is that day |
| `valhalla` | `ghcr.io/gis-ops/docker-valhalla/valhalla:latest` | floating |

**How it presents:** the `v1.8` downgrade is the sharp one. The current `livekit.yaml` and the egress
configs were written against 1.13/1.14 behaviour; a config key that 1.13 honours and 1.8 ignores is
silently dropped, not rejected, and the symptom is "some calls do not connect" with no log line.
The `:latest` tags are the slow-burn version — MinIO in particular has shipped breaking console and
licensing changes, and you would find out mid-rebuild with the site down.

**Before the rebuild:** pin all five to the digests currently running
(`docker inspect --format '{{index .RepoDigests 0}}' <container>`).

---

## 11. Profiles: a plain `docker compose up -d` starts none of the media stack

Every media and monitoring service sits behind a profile:

```
legacy      : api, kafka, fanout-worker
sfu         : livekit, livekit-egress
golive      : golive-redis, golive-livekit, golive-egress
monitoring  : prometheus, grafana
```

So `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` brings up Caddy, go-api,
Postgres, pgbouncer, Redis, MinIO, Valhalla and coturn — and **no LiveKit, no egress, no Go Live, no
Prometheus, no Grafana.**

**How it presents:** REST works, chats work, the app looks healthy. 1:1 mesh calls still work, since
those are peer-to-peer over coturn. **Group calls and Go Live fail** — they are the only two things that
need the SFU. That is a narrow enough surface that a smoke test focused on messaging misses it entirely.

**Worse: the running stack was not assembled with a consistent overlay set.** Per-container compose
labels:

| Container | Config files it was created from |
|---|---|
| `vaultchat-livekit-1` | `docker-compose.yml` **only** |
| `vaultchat-golive-livekit-1`, `golive-egress`, `golive-redis`, `caddy` | `docker-compose.yml`, `prod.yml` |
| `vaultchat-go-api-1`, `grafana`, `kafka` | `docker-compose.yml`, `prod.yml`, `box.yml` |

The box is the residue of a series of ad-hoc `up -d <service>` calls with different `-f` sets. A single
uniform `up` — which is exactly what a rebuild is — recreates `vaultchat-livekit-1` with `prod.yml`
overrides it has never actually had. **Nobody has ever observed this stack coming up from one command.**

**Before the rebuild:** write down the one exact command, with every `-f` and every `--profile`, and
dry-run it with `docker compose … config` against the existing box to see what it would change.

---

## 12. Data outside Postgres — what survives, what does not

| Data | Where | Survives container recreate? | Survives box teardown? |
|---|---|---|---|
| Postgres (`vaultchat` + `vaultgames`) | volume `vaultchat_pgdata` | Yes | **Only if the volume is preserved or restored from dump** |
| MinIO — `vaultchat-broadcast` (67 prefixes) + `vaultchat-media`, **6.3 GB** | volume `vaultchat_miniodata` | Yes | **No. Nothing dumps it.** |
| Grafana dashboards, users, API keys (`grafana.db`, 1.0 MB) | volume `vaultchat_grafanadata` | Yes | **No.** And the live container mounts only `grafana-datasource.yml` — the repo's `grafana-dashboard.yml` and `monitoring/dashboards/vaultchat-sli.json` are **not** mounted, so anything in Grafana today was made by hand and exists only in that volume. |
| Redis (presence, Socket.IO adapter, queues) | volume `vaultchat_redisdata` | Yes | No — and it does not matter, all derivable |
| Kafka | volume `vaultchat_kafkadata` | Yes | **Irrelevant — `kafka-topics.sh --list` returns zero topics.** Kafka is running and entirely unused; only the `legacy` Node profile sets `EVENT_BUS=kafka`. |
| Valhalla tiles, 9.8 GB | **bind mount**, untracked | Yes | **No** — see #5 |
| coturn TLS cert | **bind mount**, gitignored | Yes | **No** — see #8 |
| `secrets/` — `fcm-service-account.json`, `games-signing.key`, `games-notify.pub` | **bind mount**, untracked | Yes | **No** — though a missing bind source is a hard container start failure, which is at least loud |
| `uploads-shared/` (`UPLOAD_DIR=/data/uploads`) | bind mount | Yes | Effectively empty — 16 KB, one `2026/` directory. Low value. |
| R2: `vaultchat-media`, `vaultchat-beam`, `vaultchat-broadcast` | external (Cloudflare) | Yes | **Yes** — genuinely external, the safest data on the system, provided #3 keeps pointing at it |
| `/opt/vaultgames` binary + `vaultgames-data` volume (`games.json`) | volume + `/opt` | Yes | **No** — see #7 |

**Grafana dashboards do not live in a named volume the repo can rebuild — they live in a named volume
only a manual export can rescue.** Export them to JSON before teardown, or accept losing them.

---

## 13. Order-of-operations traps

Things that work only because of the order in which they were first created:

1. **pgbouncer vs. roles — safe, noted so nobody "fixes" it.** pgbouncer's `[databases]` entry uses
   `auth_user=vaultchat` and looks hashes up in Postgres at connect time, so it does not need roles to
   pre-exist and does not need a seeded `userlist.txt`.
2. **coturn's cert must exist before coturn starts.** The bind mount is `coturn/certs/{cert,pkey}.pem`.
   If certbot has not issued `turn.corefinite.com` yet when `docker compose up` runs, Docker creates
   *directories* at those paths and **coturn starts with no TLS listener at all** — running, logging
   nothing unusual, TURNS dead. The deploy hook's comments say this has already happened once.
   Correct order: certbot → hook → `up -d coturn`.
3. **`secrets/` must be seeded before go-api starts.** Three bind-mounted files from
   `docker-compose.prod.yml`. This one fails loudly (container will not start), which is deliberate.
4. **LiveKit needs Redis reachable on `127.0.0.1:16379` from the *host*.** It runs `network_mode: host`
   and cannot resolve the `redis` service name. Without the loopback port mapping, LiveKit returns
   HTTP 500 on `/rtc/v1` — `could not get node for room` — and **every** SFU join fails.
   `docker-compose.prod.yml` documents this at length. `up` brings Redis with the mapping, but a partial
   `up -d livekit` before Redis does not.
5. **Valhalla tiles must be present before the container starts** — otherwise it begins a tile build (#5)
   with no obvious signal that it is doing so.
6. **The two host-networked SFUs must not collide** — 7880/7881/7882 vs 7890/7891/7892. A collision
   fails to bind loudly, so this one is safe.
7. **ufw and the custom firewall units must be in place before media is needed.** See #14 — this is the
   one that fails silently.

---

## 14. Host state with no repo representation

None of the following is in this working tree:

- **ufw rules — 34 of them.** Critically: `3478`/`5349` (TURN), `49152:65535/udp` (TURN relay range),
  `7881/tcp` + `7882/udp` (calling SFU RTC), `7891/tcp` + `7892/udp` (Go Live RTC), `443/udp` (HTTP/3).
  Without these a rebuilt box passes every HTTP smoke test and **every call silently fails to establish
  media** — signalling succeeds, ICE finds no working candidate, the call just never connects.
- **`vaultchat-firewall.service`** → `/usr/local/sbin/vaultchat-firewall.sh` (edge rules, re-applied
  after Docker rebuilds `DOCKER-USER`).
- **`vaultchat-docker-firewall.service`** → `/usr/local/sbin/vaultchat-docker-firewall.sh` — blocks
  internet access to Docker-published internal ports, i.e. this is what stops MinIO on `0.0.0.0:19000`
  from being world-readable. **Losing this is a security regression, not an outage**, so nothing breaks
  and nobody notices.
- **`vaultchat-logs.service`** → runs `/home/srihari/vaultchat/admin/logserver.py` with
  `EnvironmentFile=/etc/vaultchat-logs.env`. The unit and the env file are box-only; the Python script
  is in the repo under `admin/`.
- **nginx vhosts.** `nginx/sites/` in the repo has 4 files; the box has 7 enabled. Missing from the repo
  entirely: `jump.corefinite.com`, `monitor.corefinite.com`, `portainer.corefinite.com`.
  `vaultchat.conf`, `vaultchat-stream.conf` and `admin.conf` match the box exactly (verified by
  comment-stripped diff). **`games.conf` differs** — the live file is certbot-managed
  (`# managed by Certbot` blocks, `options-ssl-nginx.conf`, `ssl-dhparams.pem`), the repo copy is not.
  `vaultchat.conf`'s own header warns that this file is copied by hand and nothing syncs it.
- **`/root/rls-role-passwords.txt`**, `/root/preflight-backup/`, and ~8 dated `vc-deploy-backup-*` /
  `vaultchat-prod-state-*` directories under `/root`.

---

## 15. The `legacy` rollback target has silently stopped existing

`docker-compose.prod.yml` documents the Node tree behind `profiles: ["legacy"]` as the emergency
rollback. Mechanically it would still build: `vaultchat-backend/Dockerfile` is present, `server.js` is
present, `npm install --omit=dev` runs at build time, and Kafka is up.

**It would not work, for a reason that has nothing to do with the build.**

```
SELECT count(*), count(email), count(email_cipher) FROM users;
  18 | 0 | 17
```

The plaintext `users.email` column is **empty for every user**. The encrypted-PII onboarding rewrite
moved identity into `email_cipher` / `phone_cipher` and lookup into the peppered `email_lookup` /
`phone_lookup` columns. The legacy Node server predates all of that and authenticates against the
plaintext columns. **A legacy rollback would come up healthy and authenticate zero users.**

Two further gaps in the same direction:

- The legacy `api` service defaults `S3_ENDPOINT` to `http://minio:9000` with dev credentials, so a
  rollback also detaches from R2 — the same failure as #3.
- It has no knowledge of `message_bodies` partitioning (migration 099) or the `SECURITY DEFINER`
  partition functions (128).

**Say it plainly: the documented emergency rollback plan does not exist any more.** It should either be
deleted from `docker-compose.prod.yml` and the docs so nobody reaches for it during an incident, or
repaired and actually tested. Leaving it in place as an untested comfort blanket is the worst of the
three options.

---

## 16. Repo ↔ box drift, in both directions

The box's own working tree is **255 files dirty** against its `HEAD` (`c9c3f24`), including
`docker-compose.yml`, `caddy/Caddyfile`, `coturn/turnserver.conf`, `livekit/livekit.yaml`, and ~40
untracked Go source files under `vaultchat-backend-go/internal/`. This local repo is on `hetzner-deploy`
at `a57b388`. **Neither tree is a superset of the other.**

Confirmed drift where the box is ahead of this repo:

```diff
# docker-compose.yml, go-api environment:
+      LIVEKIT_HTTP_URL: ${LIVEKIT_HTTP_URL:-}
+      GOLIVE_LIVEKIT_HTTP_URL: ${GOLIVE_LIVEKIT_HTTP_URL:-}
```

Without those two passthroughs the SFU HTTP API base URLs never reach go-api at all — the same class of
failure as #9, but from the compose side rather than the value side. `livekit.yaml` differs as covered in
#4. `coturn/turnserver.conf` differs only in comments and the position of `verbose` (harmless).
`caddy/Caddyfile`, `docker-compose.prod.yml` and the three matching nginx vhosts are identical modulo
comments and line endings.

**Before the rebuild:** reconcile the box's tree into git *first* and rebuild from the reconciled commit.
Rebuilding from `a57b388` as it stands ships a stack the box has never run.

---

## Pre-flight checklist — capture from the running box before teardown

Run all of these **while the box is still up**, and store the output somewhere that is not the box.

**Secrets and keys — irreplaceable, do these first**

- [ ] `scp root@65.21.229.167:/home/srihari/vaultchat/vaultchat-backend/.env ./` — **`VAULTCHAT_MASTER_KEY` and `VAULTCHAT_LOOKUP_PEPPER` cannot be regenerated**
- [ ] `scp …:/home/srihari/vaultchat-backups/.offsite-key ./` and `…/vaultchat-backups/backup.sh`
- [ ] `scp …:/home/srihari/vaultchat/docker-compose.box.yml ./` (R2 credentials)
- [ ] `scp …:/home/srihari/vaultchat/.env ./`
- [ ] `scp -r …:/home/srihari/vaultchat/secrets/ ./` — 3 files
- [ ] `scp …:/root/rls-role-passwords.txt ./`
- [ ] `scp -r …:/opt/vaultgames/keys/ ./`
- [ ] **Test-decrypt one `.enc` object from R2 with `.offsite-key` before trusting any of it**

**Certificates**

- [ ] `ssh … 'tar -czf - /etc/letsencrypt' > letsencrypt.tgz` — includes the ACME account key; restore it **before** nginx first starts on the new box so certbot re-issues nothing
- [ ] `scp …:/etc/letsencrypt/renewal-hooks/deploy/coturn.sh ./` and commit it
- [ ] `scp -r …:/home/srihari/vaultchat/coturn/certs/ ./`
- [ ] Record the nine lineages so you can verify all nine came back: `admin`, `api`, `games`, `jump`, `monitor`, `portainer`, `teleport`, `turn` under `corefinite.com`

**Data**

- [ ] Fresh `pg_dump` of **both** databases, off-box:
      `docker exec vaultchat-postgres-1 pg_dump -U vaultchat -d vaultchat  --no-owner | gzip > vaultchat.sql.gz`
      `docker exec vaultchat-postgres-1 pg_dump -U vaultchat -d vaultgames --no-owner | gzip > vaultgames.sql.gz`
- [ ] `docker run --rm -v vaultchat_miniodata:/d -v $PWD:/out alpine tar -czf /out/minio.tgz /d` — **6.3 GB, nothing else backs this up**
- [ ] Export Grafana dashboards to JSON via the API (`GET /api/search`, then `GET /api/dashboards/uid/<uid>`) — they exist only in `vaultchat_grafanadata`
- [ ] `tar` `/home/srihari/vaultchat/valhalla/` — 9.8 GB, or accept a multi-hour rebuild
- [ ] `tar` `/opt/vaultgames/` whole — **there is no source for this binary**

**Configuration and host state**

- [ ] Commit the box's 255 dirty files (§16) and rebuild from *that* commit, not from `a57b388`
- [ ] `ufw status numbered > ufw.txt` — 34 rules; TURN and SFU media depend on them
- [ ] `scp -r …:/etc/nginx/sites-available/ ./` — 3 vhosts are not in the repo and `games` has drifted
- [ ] `scp …:/usr/local/sbin/vaultchat-firewall.sh …:/usr/local/sbin/vaultchat-docker-firewall.sh ./`,
      the three `/etc/systemd/system/vaultchat-*.service` units, and `/etc/vaultchat-logs.env`
- [ ] `crontab -u srihari -l` and `cat /etc/cron.d/vaultgames-backup`
- [ ] Pin image digests: `for c in $(docker ps --format '{{.Names}}'); do docker inspect --format '{{.Name}} {{.Config.Image}} {{.Image}}' $c; done`
- [ ] Record `docker network inspect vaultchat_default` (currently `172.20.0.0/16`) — or pin it in compose and stop depending on it
- [ ] Write down the **one exact** `docker compose -f … -f … --profile … up -d` command; today's stack was never brought up by a single command

**Fix before rebuilding, not after**

- [ ] Replace `REPLACE_WITH_LIVEKIT_API_KEY` in `livekit/livekit.yaml`; commit `livekit/golive.yaml`
- [ ] Decide whether `127.0.0.1:14000` should be published, and confirm webhooks actually land **on the current box** so you have a known-good baseline
- [ ] Either repair the `legacy` profile or delete it, so the rollback plan is honest either way

---

## What I could not determine

- **Whether anything still reads the MinIO `vaultchat-media` bucket.** `go-api`'s `S3_*` points at R2,
  but nginx still proxies `/vaultchat-media` to MinIO on `127.0.0.1:19000`, and the bucket has data in
  it. Older `attachments` rows may resolve through that path. I did not query `attachments` for which
  backend each row references. **Assume the MinIO bucket is live until proven otherwise.**
- **Whether `teleport.corefinite.com` is still in use** — there is a lineage (last touched 2026-06-17)
  but no matching nginx vhost. It may be abandoned; renewing it costs nothing, so it stays in the
  capture list regardless.
- **What `/opt/vaultgames/go-server` was built from.** No source, no build metadata, no upstream
  reference found on the box. If that binary is lost, the games feature cannot be rebuilt at all.
- **Whether the Grafana volume holds dashboards worth keeping.** `grafana.db` is 1.0 MB — more than an
  empty install — but `sqlite3` is not available in the container, so I could not enumerate them without
  writing to the box. Export via the HTTP API before teardown.
- **The exact `docker compose` invocation history.** Reconstructed from per-container labels (§11), not
  from a record — there is no deploy log that captures it.
