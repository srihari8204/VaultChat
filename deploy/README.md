# Bringing VaultChat up on a bare Ubuntu box

From nothing but this repository and a secrets file.

This exists because until now it did not. Production was deployed by `scp`-ing
individual source files over a git checkout that sat ~370 commits behind origin
with 255 modified files on top of it, and a third of the configuration —
`docker-compose.box.yml` — existed only as a 0600 file in one person's home
directory, in no repository, with no copy. Nobody could reconstruct the running
deployment. That is finding **P0-02** of the architecture review, and these four
files are the answer to it:

| File | What it is |
|---|---|
| `deploy/README.md` | this — the order, and the manual steps |
| `deploy/docker-compose.box.yml.example` | the box-only override, reconstructed, secrets parameterised |
| `deploy/env.example` | every variable, both env files, what breaks when each is missing |
| `scripts/deploy.sh` | one deploy, replacing the six ad-hoc `deploy-*.sh` |

**Read `docs/SERVER_INVENTORY.md` first if you are rebuilding the existing
box rather than standing up a new one.** It is the read-only census of what is
actually on 65.21.229.167 — which volumes are the only copy of something, which
certificates would hit a Let's Encrypt rate limit if reissued, which state
cannot be recreated from any file here. This document is the *procedure*; that
one is the *inventory*. Neither replaces the other.

---

## 0. What you cannot script, and must do by hand first

None of these are laziness. Each one is a credential issued by somebody else, or
a fact about the internet, and no amount of bash produces them.

| # | Manual step | Why it cannot be scripted | What breaks without it |
|---|---|---|---|
| 1 | **DNS A records** at Cloudflare: `api`, `turn`, `games`, `monitor`, `portainer`, `jump` direct to the box's IP; `stream` and `admin` proxied. **There is no wildcard** — a new subdomain needs a new record before its vhost can do anything. | The zone lives in a Cloudflare account whose credentials are not on the box. | certbot cannot issue, so there is no TLS, so there is no API. `turn` must stay **direct** — TURN cannot be proxied. |
| 2 | **Firebase service account JSON** → `secrets/fcm-service-account.json` | Downloaded by hand from the Firebase console (project `vaultchatprod01`). Reissuable if lost. | No push notifications, and no incoming-call ring when the app is killed. |
| 3 | **Cloudflare R2**: create the buckets, issue an S3 API token, note the account id. | Console-issued. | Attachments, VaultBeam transfers, **and the encrypted off-site database backup** all fail. |
| 4 | **`VAULTCHAT_MASTER_KEY` + `VAULTCHAT_LOOKUP_PEPPER`** — generate once, or copy from the old box. | ☠ **Not rotatable.** They decrypt PII already in the database. Regenerate against an existing database and every stored phone number and email becomes permanently unreadable; a backup restore does not help, because the backup is encrypted with the key you just lost. | On a fresh database: nothing. On an existing one: total, irreversible PII loss. |
| 5 | **Two LiveKit key pairs** — `docker run --rm livekit/livekit-server generate-keys`, twice. Paste the *key id* literally into `livekit/livekit.yaml` and `livekit/golive.yaml`. | Those YAML files get **no `${VAR}` expansion** — LiveKit reads them verbatim. The repo ships `REPLACE_WITH_LIVEKIT_API_KEY` as a placeholder. | A placeholder left in place means every webhook is signed with a key the receiver rejects, and broadcasts silently never leave `starting`. |
| 6 | **Resend API key + a verified sender domain** | Third-party, DNS-verified. | Email OTP fails; signup with an email address cannot complete. |
| 7 | **Google Web Client ID** — must be the *same* one the mobile app ships. | From the Google Cloud console. | Google Sign-In is rejected. OTP still works. |
| 8 | **Klipy API key** | Third-party. The test key is capped at 100 calls/hour. | The GIF/sticker picker returns empty. Nothing else breaks. |
| 9 | **Play app-signing SHA-256** into `caddy/public/assetlinks.json`, after the first Play upload. | Google generates it on upload; it does not exist beforehand. | `/live/join/<code>` invitation links open a browser tab instead of the app. |
| 10 | **`/etc/letsencrypt/`** — restore it from the old box (`tar czf letsencrypt.tgz /etc/letsencrypt`) rather than reissuing. | Let's Encrypt allows 5 duplicate certs per domain set per week. One iterated rebuild — fix, retry, fix, retry — and `api.corefinite.com` has no HTTPS for seven days. | See above. This is the single easiest way to take the API down for a week. |

---

## 1. Host preparation

Ubuntu 24.04 LTS. Docker Engine with the Compose v2 plugin — not `docker-compose` v1, the
override semantics below (`!override`) need v2.

```bash
curl -fsSL https://get.docker.com | sh
docker compose version          # must print v2.x
sudo apt-get install -y nginx certbot python3-certbot-nginx rsync git
```

Firewall and the loopback-only port policy are already scripted:

```bash
bash scripts/ops/server-hardening-2026-08-10.sh --dry-run   # read it first
bash scripts/ops/server-hardening-2026-08-10.sh
```

That installs `vaultchat-firewall.service`. The companion
`vaultchat-docker-firewall.service` — which blocks internet access to
docker-published internal ports — is **on the box but not in this repo**; see
§7.

Ports that must be open to the internet, and only these: `80`, `443`, `3478`
(TURN), `7881`+`7882` (calling RTC), `7891`+`7892` (Go Live RTC), `19000`
(MinIO, presigned uploads). Everything else is loopback.

---

## 2. Lay down the checkout

```bash
sudo mkdir -p /home/srihari/vaultchat
sudo chown "$USER" /home/srihari/vaultchat
git clone -b hetzner-deploy <repo> /home/srihari/vaultchat
cd /home/srihari/vaultchat
```

**Use a clean clone, and keep it clean.** The existing box does not, which is
how it reached 255 modified files and stopped being able to answer "what is
running?". `scripts/deploy.sh` refuses to deploy from a dirty tree for exactly
this reason.

### The three compose files, and the order they are passed

```
docker-compose.yml          the bench       — in git
docker-compose.prod.yml     any prod box    — in git
docker-compose.box.yml      THIS box        — build it from the example, NEVER commit it
```

```bash
cp deploy/docker-compose.box.yml.example docker-compose.box.yml
$EDITOR docker-compose.box.yml       # read the comments; one of them is a live bug
chmod 600 docker-compose.box.yml

# `.gitignore` does NOT currently cover it — `*.env` does not match this name.
# It holds live R2 credentials. Add the line before you commit anything:
grep -qx 'docker-compose.box.yml' .gitignore || echo 'docker-compose.box.yml' >> .gitignore
```

Every command from here on uses all three, in that order:

```bash
DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml"
```

Drop the third and nothing errors: go-api starts, answers `/health`, and writes
every attachment into a local MinIO bucket no client has a URL for.

### The two env files

They are **not interchangeable**, and this is the most expensive thing to get
wrong here. `./.env` is read by *docker compose*, to expand `${VAR}`.
`./vaultchat-backend/.env` is read by the *container*, via `env_file:`. A
service's `environment:` beats `env_file:` — and `${VAR:-default}` *is* an
`environment:` entry, so an unset variable materialises its bench default and
still wins over the file. Putting `S3_*` in the wrong one changes nothing,
silently, with no error to explain it.

```bash
awk '/SECTION A ---/,/END SECTION A/' deploy/env.example > .env
awk '/SECTION B ---/,/END SECTION B/' deploy/env.example > vaultchat-backend/.env
chmod 600 .env vaultchat-backend/.env
$EDITOR .env vaultchat-backend/.env     # replace every CHANGE_ME
```

### Secrets are files, not variables

```bash
mkdir -p secrets && chmod 700 secrets
# copy in: fcm-service-account.json, games-signing.key, games-notify.pub
chmod 600 secrets/*
sudo chown 1000:1000 secrets/*     # uid 1000 == the container's `app` user
```

Mounted read-only at `/run/secrets`, so the material never appears in
`docker inspect`, `docker compose config`, the process environment or a crash
dump — only a path does. A **missing** file here is a hard container start
failure, not a warning, which is why this mount lives in `prod.yml` and not in
`docker-compose.yml` (the bench has no `secrets/`).

---

## 3. Bring-up, in the order that matters

The order is not stylistic. Each step depends on the previous one existing.

### 3.1 Database first

Nothing else can start meaningfully without it, and migrations cannot run
against a database that is not up.

```bash
$DC up -d postgres pgbouncer redis
docker exec vaultchat-postgres-1 pg_isready -U vaultchat     # wait for "accepting connections"
```

### 3.2 Migrations second — before any API binary

**The API queries columns a migration creates.** Every migration in this repo is
additive (a new nullable column, a new table), so the *old* binary tolerates the
*new* schema and ignores what it does not know. The reverse is not true: a new
binary against an old schema queries a column that does not exist and 500s every
request that touches it. Schema first, always.

On a bare box there is no `go-api` image yet, so `scripts/deploy.sh` cannot run
(it deploys *to* a box, from your machine). Apply them directly — this is the
same routine step 5 of that script runs, minus the already-applied check, which
on an empty database has nothing to skip:

```bash
docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (
     version TEXT PRIMARY KEY, filename TEXT NOT NULL,
     checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"

cd vaultchat-backend/migrations
for f in $(ls *.sql | sort); do
  v=${f%%_*}
  cs=$(sed 's/\r$//' "$f" | sha256sum | cut -c1-16)
  { sed 's/\r$//' "$f"
    printf "INSERT INTO schema_migrations(version,filename,checksum) VALUES ('%s','%s','%s');\n" "$v" "$f" "$cs"
  } | docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -1
done
```

From then on `scripts/deploy.sh` owns this step and skips what the ledger
already records. (`vaultchat-backend/migrate.js` is the original runner and
still the right tool from a developer machine with a tunnel — but no Node
runtime remains on the box, so it is not the box-side path.)

`sed 's/\r$//'` is not cosmetic: this repo is developed on Windows and checks
out mixed CRLF/LF. A checksum that notices line endings reports every migration
as drifted from a Windows tree — observed, 80 of 81 "drifted", all of them
purely CRLF, which is enough noise to hide the one real mismatch.

There is **no automatic down migration**. Each file runs in its own transaction
with `ON_ERROR_STOP`, so a bad file rolls itself back and stops the run with the
ledger consistent. A file that *committed* and then turns out to be wrong is
undone by writing the next migration.

### 3.3 Object storage

```bash
$DC up -d minio
# create both buckets once, via the MinIO console or mc:
#   vaultchat-media       (user media — production points S3_* at R2 instead)
#   vaultchat-broadcast   (HLS segments — stays on MinIO even in production)
```

This deployment runs **two** object stores and the split is invisible from
`docker-compose.yml`: `S3_*` points at R2 while the LiveKit egress service keeps
writing segments to MinIO. `BROADCAST_S3_*` is how go-api reads the second one.
Get that wrong and the playback relay authenticates to MinIO with R2 credentials
and every segment 404s.

### 3.4 The API

```bash
$DC build --pull go-api
$DC up -d --no-deps go-api
```

**`--pull` is not optional.** The Dockerfile builds `FROM golang:1.26-alpine` —
a *floating* tag. Without `--pull` the build silently reuses whichever base
layer this box happens to have cached: production sat on go1.26.5 for weeks
while 1.26.6/.7/.8 shipped standard-library fixes, and nothing anywhere said so.
`GET /build` now reports the toolchain, which is how that became visible.

```bash
curl -s localhost:8095/health   # {"status":"ok",...}  — wait, see 3.7
```

### 3.5 Media servers and routing

Profile-gated, so they do not start with the default set. **Bring them up by
name, and never pass `--remove-orphans`** — compose knows fewer services than
the box runs, so that flag deletes both LiveKit servers and both egress
containers: every call and every broadcast, at once.

```bash
$DC --profile sfu    up -d livekit egress
$DC --profile golive up -d golive-redis golive-livekit golive-egress
$DC up -d coturn valhalla prometheus grafana
```

Go Live's egress needs **four CPUs as a floor**. Below it, room-composite egress
refuses to run and then still logs `service ready`, so every broadcast dies in
`starting` with one startup line as the only evidence.

Valhalla needs ~9.8 GB of routing tiles in `valhalla/custom_files/` — a 1.7 GB
OSM download plus a multi-hour tile build. **Copy that directory from the old
box; do not rebuild it.** In-app turn-by-turn is dead while it builds.

### 3.6 Caddy last

Caddy is a router. Every `reverse_proxy` in `caddy/Caddyfile` names an upstream —
`go-api:4000`, `host.docker.internal:7880`, `host.docker.internal:7890` — and a
router started before its upstreams exist is a router that answers 502 to
everything, including the health check you are about to use to decide whether
the deploy worked.

```bash
$DC up -d caddy
curl -s localhost:8095/health
```

Caddy binds **`127.0.0.1:8095`**, not `:80`. It is *not* the edge. Published on
`0.0.0.0:80` it serves the entire API, auth included, over plaintext HTTP to the
open internet — it has done exactly that before.

### 3.7 nginx and TLS — the actual edge

```
client ──443──► nginx (host) ──► 127.0.0.1:8095 (caddy) ──► go-api:4000
```

```bash
sudo cp nginx/sites/vaultchat.conf        /etc/nginx/sites-available/vaultchat
sudo cp nginx/sites/vaultchat-stream.conf /etc/nginx/sites-available/vaultchat-stream
sudo cp nginx/sites/games.conf            /etc/nginx/sites-available/games
sudo ln -sf /etc/nginx/sites-available/{vaultchat,vaultchat-stream,games} /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.corefinite.com -d stream.corefinite.com -d turn.corefinite.com
```

`nginx -t` before every reload, without exception — a syntax error takes down
every vhost on the box, not just the one you edited.

These files are **copied, not mounted**, so nothing keeps them in sync. The live
copy has drifted before: the `/vaultchat-media` block existed only on the server
for a while, and copying an older revision over it would have silently broken
every attachment upload. Always diff first:

```bash
ssh <host> 'cat /etc/nginx/sites-enabled/vaultchat' | diff nginx/sites/vaultchat.conf -
```

Finally, the certbot deploy hook that keeps coturn's certificate current —
`/etc/letsencrypt/renewal-hooks/deploy/coturn.sh`. coturn reads its cert only at
startup and the failure is silent (ICE just moves to another candidate and calls
quietly get worse), so this must be recreated by hand. See
`docs/SERVER_INVENTORY.md` §6 for the exact ownership it needs — root-owned 640
is unreadable to the container's `nobody` user, and coturn then starts with no
TLS listener at all.

---

## 4. Verify

```bash
curl -s  localhost:8095/health                       # {"status":"ok","db":true,"redis":true}
curl -sw '%{http_code}\n' -o /dev/null localhost:8095/ready   # 200; 503 = database unreachable
curl -s  localhost:8095/build                        # {"source":"<16 hex>","go":"go1.26.x",...}
bash scripts/fingerprint-go.sh                       # must equal that "source"
curl -sw '%{http_code}\n' -o /dev/null -X POST localhost:8095/calls/x/sfu-token   # 401 = routed and authenticating
```

`/build` is the one that matters. A commit SHA cannot identify what is running
on a box that builds from a working tree, so the binary reports a hash of the
source it was compiled from. Equal means the box is running this checkout.
Different means it is not, and no amount of `git log` will tell you that.

---

## 5. Every deploy after the first

```bash
bash scripts/deploy.sh
```

One script. It refuses a dirty or stale checkout, rsyncs with `--delete` (scp
only ever added — a `.go` file deleted in the repo stayed on the box forever and
kept being compiled in), runs migrations before the binary, builds with
`--pull`, restarts `go-api` alone, and then verifies health, ready, and that
`/build` reports the fingerprint computed locally — rolling back source *and*
image if any of that fails.

The six older `scripts/deploy-*.sh` are deliberately left in place. Each one
documents a specific incident worth keeping; none of them should be the way a
deploy happens any more.

---

## 6. Restore, if this is a rebuild and not a new deployment

In this order, before step 3.4:

1. `/etc/letsencrypt/` — restore, do not reissue (§0 #10).
2. `vaultchat_pgdata` — the product database, plus the `vaultgames` database.
3. `vaultchat_miniodata` — **6.6 GB and the only copy.** No off-site replication
   of MinIO exists.
4. `valhalla/custom_files/` — 9.8 GB of tiles.
5. Both `.env` files and `secrets/` — including `VAULTCHAT_MASTER_KEY` and
   `VAULTCHAT_LOOKUP_PEPPER`, which cannot be regenerated.
6. `/home/srihari/vaultchat-backups/.offsite-key` — the passphrase for every
   encrypted off-site backup. It exists in exactly one place.

---

## 7. What this README cannot bring up

Honesty is the point of this section. A bare box built from this document gets
you the API, the database, both SFUs, TURN, object storage, monitoring, and the
edge. It does **not** get you these, and no file in this repository does either:

| Missing | What it is | Consequence |
|---|---|---|
| **`vaultchat-games`** | A prebuilt image with **no source in this repo**, no Dockerfile, and no compose entry — started by hand with `docker run` and backed by the `vaultgames-data` volume, `/opt/vaultgames/keys/` and its own cron backup. | `games.corefinite.com` cannot be rebuilt at all. Copy the image and `/opt/vaultgames` or the mini-app is gone. |
| **`docker-compose.yml` drift** | The box's copy is **not** the repo's. It adds a dedicated `golive-redis` service and runs `livekit/livekit-server:v1.13.5` and `livekit/egress:v1.14.0`; the repo still says `v1.8`/`v1.8.4` and points Go Live's egress at the shared Redis with `db: 3`. The box's own comment records that the shared-Redis shape produced a publisher transport that never settled. | Following this README verbatim deploys a **Go Live that does not work**. Reconcile `docker-compose.yml` against the box before trusting §3.5. |
| `vaultchat-docker-firewall.service` | Blocks internet access to docker-published internal ports. On the box, in no repo file. | Docker's own iptables rules bypass UFW; without this unit, published "internal" ports are reachable from the internet. |
| `/opt/vaultgames/keys/`, `/etc/vaultchat-logs.env`, `beszel-agent.service` | Credentials held inline in host files. | Games DB access, the admin log API, and host monitoring each stop. |
| Valhalla tiles, MinIO objects, Postgres data | State, not configuration. | §6. |
| JumpServer, Portainer, Beszel, SearXNG (12 containers) | Co-tenants of the same box, unrelated to VaultChat, managed outside this compose project. | Not VaultChat's problem, but they are on the box and they are not in this repo. |
| ~23 `*.bak-*` files | A dozen compose and Caddyfile variants accumulated on the box as ad-hoc rollback points. | They are not history, they are noise, and two of them differ from the live file in ways nobody has diffed. Delete them once the git history above is trusted. |

**Verdict: a bare box can be brought up from this README alone — as an API,
with calls, storage and TLS. It cannot be brought up as a full production clone,
because the games mini-app has no source here and the repo's
`docker-compose.yml` would deploy a broken Go Live.** Those two gaps are the
remaining work, and they are the honest output of reconstructing this.
