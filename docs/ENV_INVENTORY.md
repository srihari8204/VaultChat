# Environment inventory — pre-rebuild checklist

Measured on the running prod box (65.21.229.167) on 2026-09-13, read-only.
Ground truth is `docker inspect` on the live containers; the `.env` files are only
what someone *intended*. Cross-referenced against every `os.Getenv` / env-helper
call in `vaultchat-backend-go`.

**No value in this document is a secret.** Only names, lengths, and 2-character
prefixes (enough to tell an S3 key from a URL) are recorded. Treat this file as public.

Compose project: `/home/srihari/vaultchat`, files
`docker-compose.yml` + `docker-compose.prod.yml` + `docker-compose.box.yml`.

---

## 1. LOSE THESE AND THE DATA IS GONE

Two variables. Both currently live **only** in `/home/srihari/vaultchat/vaultchat-backend/.env`
on the box (mode 600, not in git — `vaultchat-backend/.gitignore:4`). There is no
second copy anywhere. Capture them before the rebuild or the existing database
becomes unusable.

| Name | len | pre | What it protects | If lost |
|---|---|---|---|---|
| `VAULTCHAT_MASTER_KEY` | 64 | `14` | HKDF root (`internal/vault/vault.go:44`, info `vaultchat-pii-v1`) for the AES-GCM encryption of **every PII column**: email, phone, first/last name, DOB, status, photo key (`internal/routes/auth.go:1586-2032`) | **PERMANENT.** Every encrypted user row is ciphertext with no key. The database cannot be used at all. No migration, no reset, no recovery. |
| `VAULTCHAT_LOOKUP_PEPPER` | 64 | `19` | The peppered digest in `users.email_lookup` / `users.phone_lookup` (`internal/vault/vault.go:62`) — the only way `/auth/lookup` and login find an existing account | **Effectively permanent.** Recoverable *only* by a full re-derivation migration (decrypt every row with the master key, re-hash with a new pepper) — and only if `VAULTCHAT_MASTER_KEY` survived. Lose both and there is nothing to re-derive from. |

Everything else in this document is regenerable. These two are not.

### Regenerable, but with a blast radius worth knowing

- `JWT_SECRET` (len 64) — rotating it invalidates every live access/refresh token. Users re-login. No data loss. **Note:** `INVITE_SECRET` is unset, and `internal/routes/chats_invitations.go:44` falls back to `JWT_SECRET` — so rotating `JWT_SECRET` also voids every outstanding group-invite link.
- `TURN_SECRET` (len 64) — must stay byte-identical to coturn's `--static-auth-secret`. Both sides read the *same* `${TURN_SECRET}` from the project `.env`, so rotating is safe as long as both restart.
- Games ed25519 keypairs (two of them, one per direction) — regenerable, but **only if both halves are rotated together**; one private key lives in the games container, its matching public key in `secrets/games-notify.pub`.
- S3 / R2 and MinIO credentials — re-issuable from the provider console. The *objects* are not at risk; only access to them.
- `secrets/fcm-service-account.json` — re-downloadable from the Firebase console (project `vaultchatprod01`).

---

## 2. SET BY HAND — EXISTS IN NO FILE IN THE REPO

Highest-risk category: a rebuild from a git checkout produces none of these.

### 2a. The entire `vaultchat-games` container (worst case)

`vaultchat-games` carries **no compose labels at all** — it was started by hand with
`docker run`, not by any compose file. A `grep -rl` across `/root` and `/home/srihari`
finds no script, compose file, or env file that mentions it. Its configuration exists
in exactly one place: the running container. Stop and remove it without capturing this
and the values are gone.

| Name | len | pre | Note |
|---|---|---|---|
| `GAMES_DB_URL` | 99 | `po` | Postgres DSN, credentials inline |
| `GAMES_REDIS_URL` | 32 | `re` | |
| `GAMES_NOTIFY_SIGNING_KEY_PEM` | multi-line | `--` | **ed25519 PRIVATE key**, inlined as a multi-line env var. Naive `sed`-style redaction does not catch it — it is the one variable here that leaks through a careless dump. |
| `VAULTCHAT_GAMES_PUBLIC_KEY_PEM` | multi-line | `--` | public half of the other direction |
| `GAMES_NOTIFY_URL` | 39 | `ht` | |
| `GAMES_ALLOWED_ORIGINS` | 28 | `ht` | |
| `GAMES_DATA_FILE`, `GAMES_LOG_LEVEL`, `GAMES_LOG_JSON`, `PORT` | — | — | operational |

Also unrecoverable from source: the image `vaultchat-games:latest` is an **external
binary with no source in this repo**. `docker save` it before the rebuild.

### 2b. `docker-compose.box.yml` — real object-storage credentials

Present on the box at `/home/srihari/vaultchat/docker-compose.box.yml` (mode 600),
**absent from the repo** (the repo has only `bench` / `golive-local` / `prod` / base).
It overrides the base compose defaults for go-api:

`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`,
`S3_REGION`, `MESSAGE_BODIES`.

**This one degrades silently.** The base `docker-compose.yml` supplies non-empty
`:-` defaults for all of them pointing at the local MinIO. Rebuild without `box.yml`
and go-api starts cleanly, passes health checks, and writes every upload to the wrong
store. Measured evidence it is overriding: `S3_ENDPOINT` len=65 (a remote HTTPS
endpoint), not the ~18-char `http://minio:9000` default.

### 2c. Secret files bind-mounted by `docker-compose.prod.yml`

`/home/srihari/vaultchat/secrets/` (700 root, files 600 uid 1000) — not in the repo:
`fcm-service-account.json`, `games-signing.key`, `games-notify.pub`.
The compose file references the paths; the material is on disk only.

### 2d. Env files (not in git, but at least referenced by the repo)

- `/home/srihari/vaultchat/vaultchat-backend/.env` — the `env_file:` for go-api. **Holds both irreplaceable keys.** 39 names.
- `/home/srihari/vaultchat/.env` — the compose interpolation source. 37 names.
- `vaultchat-backend/.env.example` **is not a usable template**: it is missing `GIPHY_KEY`, `TENOR_KEY`, `KLIPY_KEY`, `TURN_HOST`, `TURN_HOST6`, `VAULTBEAM_S3_*`, `VAULTCHAT_TERMS_VERSION`, `SEARXNG_URL`, `EMAIL_FROM`, `SENTRY_*`, and the whole LiveKit/GOLIVE block. Do not rebuild from it.

### 2e. Repo/box drift that will bite on rebuild

`docker-compose.yml` differs for real (repo 702 lines, box 647 — not just line endings).
The repo's go-api `environment:` block is **missing two keys the box has**:
`LIVEKIT_HTTP_URL` and `GOLIVE_LIVEKIT_HTTP_URL`. See section 4 — both degrade silently.
(`docker-compose.prod.yml` is identical modulo CRLF.)

---

## 3. FULL TABLE — what is set on `vaultchat-go-api-1`

All 69 non-`PATH` variables on the live go-api container. "Where" is the source that
actually wins at `docker compose up`. Class: **CRIT** = irreplaceable, **SEC** =
secret but regenerable, **CFG** = non-secret config, **DEAD** = read by nothing (section 5).

| Name | len | pre | Where it lives | Class |
|---|---|---|---|---|
| `VAULTCHAT_MASTER_KEY` | 64 | `14` | backend/.env | **CRIT** |
| `VAULTCHAT_LOOKUP_PEPPER` | 64 | `19` | backend/.env | **CRIT** |
| `JWT_SECRET` | 64 | `Gf` | backend/.env (+ project .env) | SEC |
| `ADMIN_KEY` | 64 | `74` | backend/.env (+ project .env, /root/.env) | SEC |
| `TURN_SECRET` | 64 | `93` | backend/.env (+ project .env, feeds the coturn flag) | SEC |
| `INTERNAL_EMIT_KEY` | 19 | `be` | compose default (base yml) | SEC |
| `S3_ACCESS_KEY` | 32 | `31` | **box.yml (hand)** | SEC |
| `S3_SECRET_KEY` | 64 | `1a` | **box.yml (hand)** | SEC |
| `S3_ENDPOINT` | 65 | `ht` | **box.yml (hand)** | CFG |
| `S3_PUBLIC_ENDPOINT` | 65 | `ht` | **box.yml (hand)** | CFG |
| `S3_BUCKET` | 15 | `va` | **box.yml (hand)** | CFG |
| `S3_REGION` | 4 | `au` | **box.yml (hand)** | CFG |
| `MESSAGE_BODIES` | 1 | `1` | **box.yml (hand)** | CFG |
| `BROADCAST_S3_ACCESS_KEY` | 9 | `va` | compose default | SEC |
| `BROADCAST_S3_SECRET_KEY` | 20 | `va` | compose default | SEC |
| `BROADCAST_S3_ENDPOINT` | 17 | `ht` | compose default | CFG |
| `BROADCAST_BUCKET` | 19 | `va` | compose default | CFG |
| `BROADCAST_CDN_BASE` | 29 | `ht` | project .env | CFG |
| `LIVEKIT_API_KEY` | 15 | `AP` | project .env | SEC |
| `LIVEKIT_API_SECRET` | 43 | `5N` | project .env | SEC |
| `LIVEKIT_URL` | 32 | `ws` | project .env | CFG |
| `LIVEKIT_HTTP_URL` | 22 | `ht` | project .env — **missing from repo compose** | CFG |
| `GOLIVE_LIVEKIT_API_KEY` | 15 | `AP` | project .env | SEC |
| `GOLIVE_LIVEKIT_API_SECRET` | 44 | `Ae` | project .env | SEC |
| `GOLIVE_LIVEKIT_URL` | 39 | `ws` | project .env | CFG |
| `GOLIVE_LIVEKIT_HTTP_URL` | 22 | `ht` | project .env — **missing from repo compose** | CFG |
| `GOLIVE_ROOM_PREFIX` | 0 | — | compose default (empty) | CFG |
| `GOLIVE_HOST_GRACE` | 0 | — | compose default (empty) | CFG |
| `GOLIVE_HOST_REAPER` | 0 | — | compose default (empty) | CFG |
| `VAULTBEAM_S3_ACCESS_KEY` | 32 | `18` | backend/.env | SEC |
| `VAULTBEAM_S3_SECRET_KEY` | 64 | `43` | backend/.env | SEC |
| `VAULTBEAM_S3_BUCKET` | 14 | `va` | backend/.env | CFG |
| `VAULTBEAM_S3_ENDPOINT` | 65 | `ht` | backend/.env | CFG |
| `VAULTBEAM_S3_PUBLIC_ENDPOINT` | 65 | `ht` | backend/.env | CFG |
| `VAULTBEAM_S3_REGION` | 4 | `au` | backend/.env | CFG |
| `DB_HOST` | 9 | `pg` | compose default | CFG |
| `DB_PORT` | 4 | `64` | compose default | CFG |
| `DB_NAME` | 9 | `va` | compose literal | CFG |
| `DB_USER` | 9 | `va` | compose literal | CFG |
| `DB_PASS` | 9 | `Vc` | compose default (also project .env, backend/.env) | SEC |
| `REDIS_HOST` | 5 | `re` | compose literal | CFG |
| `REDIS_PORT` | 4 | `63` | compose literal | CFG |
| `REDIS_PASS` | 0 | — | compose literal (empty) | CFG |
| `REDIS_ADAPTER` | 1 | `1` | compose default | CFG |
| `PORT` | 4 | `40` | compose literal | CFG |
| `PUBLIC_BASE_URL` | 26 | `ht` | project .env | CFG |
| `NODE_INTERNAL_URL` | 15 | `ht` | compose literal | CFG |
| `UPLOAD_DIR` | 13 | `/d` | compose literal | CFG |
| `TURN_HOST` | 19 | `tu` | backend/.env | CFG |
| `TURN_HOST6` | 19 | `2a` | backend/.env | CFG |
| `KLIPY_KEY` | 64 | `DQ` | backend/.env | SEC |
| `RESEND_API_KEY` | 36 | `re` | backend/.env (+ project .env) | SEC |
| `EMAIL_FROM` | 34 | `Va` | backend/.env (+ project .env) | CFG |
| `GOOGLE_WEB_CLIENT_ID` | 72 | `20` | backend/.env (+ project .env) | CFG |
| `VAULTCHAT_TERMS_VERSION` | 1 | `1` | backend/.env | CFG |
| `JWT_ACCESS_TTL` | 3 | `90` | backend/.env | CFG |
| `JWT_REFRESH_TTL` | 7 | `25` | backend/.env | CFG |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | 29 | `/r` | prod.yml (path only; file is hand-placed) | CFG |
| `GAMES_SIGNING_PRIVATE_KEY_FILE` | 30 | `/r` | prod.yml (path only; file is hand-placed) | CFG |
| `GAMES_NOTIFY_PUBLIC_KEY_FILE` | 29 | `/r` | prod.yml (path only; file is hand-placed) | CFG |
| `HOST` | 9 | `12` | backend/.env | DEAD |
| `NODE_ENV` | 10 | `pr` | backend/.env | DEAD |
| `PG_STATEMENT_TIMEOUT` | 5 | `10` | backend/.env | DEAD |
| `SENTRY_DSN` | 95 | `ht` | backend/.env | DEAD |
| `SENTRY_TRACES_SAMPLE_RATE` | 3 | `0.` | backend/.env | DEAD |
| `OLLAMA_URL` | 22 | `ht` | backend/.env | DEAD |
| `SEARXNG_URL` | 21 | `ht` | backend/.env | DEAD |
| `GIPHY_KEY` | 32 | `LA` | backend/.env | DEAD |
| `TENOR_KEY` | 14 | `yo` | backend/.env | DEAD |

### Infrastructure containers (non-go-api)

| Container | Variables | Where |
|---|---|---|
| `vaultchat-postgres-1` | `POSTGRES_USER` (9,`va`), `POSTGRES_PASSWORD` (9,`Vc`), `POSTGRES_DB` (9,`va`), `PGDATA` | compose |
| `vaultchat-pgbouncer-1` | `DB_HOST/PORT/USER/NAME`, `DB_PASSWORD` (9,`Vc`), `AUTH_TYPE`, `POOL_MODE`, `LISTEN_PORT`, `MAX_CLIENT_CONN`, `DEFAULT_POOL_SIZE` | compose |
| `vaultchat-minio-1` | `MINIO_ROOT_USER` (9,`va`), `MINIO_ROOT_PASSWORD` (20,`va`) | compose (`${MINIO_USER/PASS:-…}` defaults) |
| `vaultchat-livekit-1` | `LIVEKIT_KEYS` (60,`AP`) | project .env |
| `vaultchat-golive-livekit-1` | `LIVEKIT_KEYS` (61,`AP`) | project .env (`GOLIVE_LIVEKIT_KEYS`) |
| `vaultchat-livekit-egress-1`, `vaultchat-golive-egress-1` | `EGRESS_CONFIG_BODY` — a **multi-line YAML blob containing the LiveKit api_key/api_secret and the S3 credentials**, same redaction hazard as the games PEM | compose |
| `vaultchat-kafka-1`, `-redis-1`, `-golive-redis-1`, `-caddy-1`, `-coturn-1`, `-grafana-1`, `-prometheus-1`, `-valhalla-1` | image defaults / non-secret tuning only | compose |

Not env, but the same rebuild risk — config material that lives in files:
`coturn/turnserver.conf` (uses `use-auth-secret`; the secret itself arrives as the
`--static-auth-secret=${TURN_SECRET}` compose flag — **the box's copy is 2262 bytes,
the repo's is 3257: they have drifted**), `livekit/livekit.yaml`, `livekit/golive.yaml`,
`caddy/`, `secrets/`.

`jms_*`, `beszel`, `portainer`, `searxng` are unrelated to VaultChat and out of scope.

---

## 4. READ BY CODE BUT UNSET — AND WHAT HAPPENS

Sorted by danger. "Silent" means the process boots, answers health checks, and is wrong.

### Fails loudly — safe

| Name | Behavior |
|---|---|
| `JWT_SECRET` (set) | `cmd/api/main.go:78` — `log.Fatal` on empty. Refuses to start. Warns below 32 chars. The only variable with a boot guard. |
| `DB_SYSTEM_USER` / `DB_SYSTEM_PASS` | Unset → `SysPool` aliases `Pool`, a documented no-op (`internal/db/db.go:144`). If *set*, any failure is fatal by design. Safe either way. |

### Silent degradation — the dangerous list

| Name | Unset → what actually happens |
|---|---|
| `TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` / `_FROM_NUMBER` / `_MESSAGING_SERVICE_SID` | **Worst of the set.** `internal/routes/auth.go:552` — `authSendOTPSMS` logs `"OTP for <phone>: <code> (Twilio not configured)"` and **returns nil, i.e. success**. Phone signup/login appears to work; no SMS is ever sent, and live OTP codes land in clear text in the container log. Currently unset on prod. |
| `LIVEKIT_HTTP_URL`, `GOLIVE_LIVEKIT_HTTP_URL` | Set on the box, **absent from the repo's compose** (2e). Empty → `RPCURL` empty (`internal/livekit/token.go:79`, `internal/golive/config.go:80`) → server-side twirp calls fall back to the public hostname, so a same-box RPC round-trips out to the edge and back. The in-repo comment records this exact failure having happened on prod. |
| `S3_*` (via a missing `box.yml`) | Silently falls back to the local-MinIO compose defaults. Uploads succeed into the wrong store. |
| `VAULTCHAT_MASTER_KEY` / `VAULTCHAT_LOOKUP_PEPPER` | No boot check. `internal/vault/vault.go:44,62` return an error *per request*; `/auth/lookup` logs and returns 500 (`auth.go:1454`). The server boots healthy and only signup/login is broken — found by users, not by monitoring. |
| `INVITE_SECRET` | Falls back to `JWT_SECRET` (`chats_invitations.go:44`). Works, but couples invite-link lifetime to JWT rotation. |
| `TRUSTED_PROXIES` | Defaults to `127.0.0.0/8,::1/128,172.28.0.0/16,172.17.0.0/16` (`auth.go:120`). Correct for the checked-in topology; **wrong the moment the new box uses different docker subnets**, and the symptom is per-IP rate limits keying off the proxy instead of the client. |
| `VALHALLA_URL` | Empty → in-app turn-by-turn navigation returns nothing (`internal/routes/nav.go:156,386,532`). |
| `GEOCODE_UPSTREAM` | Empty → geocoding disabled (`nav.go:224`). |
| `DELETE_ON_DELIVERY` (+ `_GRACE_SEC`, `_MAX_AGE_DAYS`, `_DEVICE_STALE_DAYS`) | `jobs.go:174` requires the literal `"true"`. Unset = retention sweep off. Intentional today; **re-verify against the intended retention policy after rebuild**, because "off" looks identical to "configured". |
| `MEDIA_TTL_HOURS` / `MEDIA_TTL_DAYS`, `RETENTION_MIN_DAYS`, `MESSAGE_BODY_TTL_SECONDS`, `MESSAGE_BODY_PARTITIONS` | Built-in defaults. Retention policy silently reverts to code defaults. |
| `VAULTCHAT_TERMS_URL`, `VAULTCHAT_UPDATE_URL`, `VAULTCHAT_UPDATE_MESSAGE`, `VAULTCHAT_REMOTE_FLAGS` | Empty → the corresponding client-facing endpoint serves nothing / no remote flags. Silent. |

### Unset with a benign default — no action needed

`DB_POOL_MAX` (30), `DB_SYSTEM_POOL_MAX` (8), `DB_QUERY_EXEC_MODE` (`exec`),
`WORKX_QUEUE`, `WORKX_WORKERS`, `COLD_SYNC_MAX_MESSAGES`, `COLD_SYNC_WARN_ONLY`,
`CALL_MAX_PARTICIPANTS`, `MESH_MAX_PARTICIPANTS`, `UPLOAD_MAX_BYTES`,
`MULTIPART_MAX_BYTES`, `BROADCAST_REAPER`, `BROADCAST_LIVE_STALE`,
`BROADCAST_STARTING_STALE`, `BROADCAST_RTMP_URLS`, `BROADCAST_RETENTION_DAYS`,
`IOS_BUNDLE_ID` (`com.vaultchat.app`), `GOLIVE_LIVEKIT_WS_URL` (alias),
`SHOPBOOK_JOBS`, `SHOPBOOK_OWNER_COLLECT`, `SHOPBOOK_SUMMARY_HOUR_UTC`,
`MINIO_USER` / `MINIO_PASS` (used only as an S3-credential fallback),
`FIREBASE_SERVICE_ACCOUNT` and `GAMES_*_PEM` (the `_FILE` variants are set instead).

### Must stay unset

`DEV_OTP` — `auth.go:698,1106`: if non-empty, that literal string is accepted as a
valid OTP for **any** account. Correctly absent on prod. Never set it on the new box.

Test-only, ignore: `CALL_TEST_DB`, `CALL_TEST_ADMIN_DSN`, `TEST_PG_URL`.

---

## 5. SET ON THE BOX, READ BY NOTHING — dead config

Zero occurrences anywhere in `vaultchat-backend-go`. All are leftovers from the
Node backend, which no longer runs (no Node container exists; the compose header
records the vaultlens worker as removed). Carrying them forward is noise:

`HOST`, `NODE_ENV`, `PG_STATEMENT_TIMEOUT`, `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`,
`OLLAMA_URL`, `SEARXNG_URL`, `GIPHY_KEY`, `TENOR_KEY`.

Two worth a second look rather than a straight delete:

- `SENTRY_DSN` / `SENTRY_TRACES_SAMPLE_RATE` — the Go backend has **no error reporting at all**. That is a gap, not just dead config.
- `GIPHY_KEY` / `TENOR_KEY` — only `KLIPY_KEY` is wired up. If the client still offers Giphy/Tenor, that path is dead server-side.

---

## 6. Client build-time variables (baked into the APK, not the server)

`EXPO_PUBLIC_ENV`, `EXPO_PUBLIC_CRYPTO_BACKEND`, `EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND`,
`EXPO_PUBLIC_MONEY_BACKEND`, `EXPO_PUBLIC_ALLOW_EMULATOR`, `EXPO_PUBLIC_SENTRY_DSN`.

Not part of the server rebuild. Note that the API base URL is a **hardcoded const**
in `constants/server.ts`, not an env var — a rebuild cannot change where installed
clients point.

---

## Rebuild checklist

1. `docker inspect vaultchat-games` → save all env; `docker save vaultchat-games:latest` (no source exists).
2. Copy `vaultchat-backend/.env` — the only home of both irreplaceable keys.
3. Copy `docker-compose.box.yml` — or object storage silently reverts to local MinIO.
4. Copy `secrets/` (3 files), `coturn/`, `livekit/`, `caddy/`.
5. Copy the project `.env`.
6. Add `LIVEKIT_HTTP_URL` + `GOLIVE_LIVEKIT_HTTP_URL` to the repo's compose before rebuilding from git.
7. Verify `DEV_OTP` is unset and `TRUSTED_PROXIES` matches the new docker subnets.
8. After boot: check `/auth/lookup` returns non-500 — that is the live proof the master key and pepper survived.
