# Deploy runbook — negotiated Protobuf responses

**Status: PREPARED, NOT RUN.** Nothing in this document has been executed
against production. It is written to be run by a person who has decided to run
it.

---

## 1. What ships

**Nine** HTTP endpoints gain a second *representation* of a response they
already serve. Not one of them gains, loses or changes a field. (This said
"Eight" while the table below listed nine rows. Count the table.)

| Endpoint | Auth | On cold start |
|---|---|---|
| `GET /app/version` | no | yes |
| `GET /app/flags` | no | yes |
| `GET /chats` | yes | yes |
| `GET /chats/delta` | yes | yes |
| `GET /user/terms` | yes | yes |
| `GET /chats/common` | yes | no |
| `GET /user/security-overview` | yes | no |
| `GET /user/backup/meta` | yes | no |
| `GET /user/contact-verifications` | yes | no |

Plus CC-Wire capability bit 9 (`typed_app_bodies`), which is already emitted
ungated by `deliverOne`.

## 2. Why this is a low-risk deploy

Four properties, each one checkable rather than asserted:

1. **This change adds no migration — which is NOT the same as "this deploy
   runs no migration."** `git status --porcelain vaultchat-backend/migrations`
   returns zero lines, and every handler on the nine endpoints was checked: not
   one query string, column list, `Scan` target or type assertion changed (the
   diff is a handler split into a data struct plus a `…Write` function, plus
   pure-conversion helpers). So the *change* is schema-neutral.

   **But `scripts/deploy.sh` step 5 applies every migration the BOX'S LEDGER is
   missing, not every migration this change added.** It lists
   `vaultchat-backend/migrations/*.sql`, subtracts what `schema_migrations`
   already holds, and runs the rest — 135 files exist, and 133/134/135 were
   committed on 2026-09-14/15. If production has not caught up, this deploy
   runs them, and it will not have been *this change* that did it.

   **And they are not all additive.** `scripts/deploy.sh`'s own header says
   "Every migration in this repo is additive — a new nullable column or a new
   table". That is false at the head of the series:
   `135_unread_bump_authoritative.sql` is `CREATE OR REPLACE FUNCTION
   vc_bump_unread(...)`, which REPLACES a live function body in place. There is
   no down migration and the restore in §6 does not touch the database.

   So: **rollback is total only if the box's ledger already contains every file
   in `vaultchat-backend/migrations/`.** Verify that in §3 before you claim it.
   If step 5 prints `applied 0 migration(s)`, the claim held. If it prints any
   other number, the deploy was not schema-neutral and §6 no longer restores
   the box completely — say so in the incident channel rather than discovering
   it later.

2. **Opt-in on the request side.** A client gets protobuf only if it sends
   `Accept: application/protobuf`. Every currently installed build sends
   `Accept: application/json` and takes a code path that is byte-identical to
   today's. **No app release is required, and none is coupled to this deploy.**

3. **The JSON literal is unmoved.** Each handler was split into a data struct
   plus a `…Write` function; the `httpx.JSON(...)` map literal was not edited.
   The Go negotiation tests assert the JSON body is byte-identical across all
   four Accept headers.

4. **Fallback on failure.** If `proto.Marshal` fails, the handler falls through
   to JSON rather than erroring. If the client cannot decode the bytes, it
   falls back to its JSON path. `/app/flags` additionally refuses to overwrite
   its cached snapshot from an undecodable response — a kill switch set
   yesterday survives a bad answer today.

## 3. Preconditions

`scripts/deploy.sh` enforces the first two itself and aborts on either.

- [ ] **Working tree clean and equal to `origin/hetzner-deploy`.** Currently
      **not met** — the tree is dirty. Commit and push first. A deploy from a
      dirty tree has no name, which is finding P0-02.
- [ ] Local fingerprint recorded: `bash scripts/fingerprint-go.sh`
- [ ] `npm test`, `npx tsc --noEmit`, `go build ./...`, `go test ./...` all green
      on the exact commit being deployed.
- [ ] You know what the box is running now:
      `ssh root@65.21.229.167 "curl -s http://127.0.0.1:8095/build"`

- [ ] **The migration ledger is level with the repo** — this is what makes §2.1
      true, and nothing in `deploy.sh` checks it *before* it starts applying.
      Read-only, run it yourself first:

      ```bash
      ssh root@65.21.229.167 "docker exec vaultchat-postgres-1 \
        psql -U vaultchat -d vaultchat -tAc \
        'SELECT count(*), max(version) FROM schema_migrations;'"
      ls vaultchat-backend/migrations/*.sql | wc -l   # locally: 134 files, max 135
      ```

      `max(version)` below the repo's highest file means step 5 WILL apply
      migrations and rollback stops being total. Decide that deliberately.

- [ ] **Capture the "before" bodies you are going to compare against.** §5 says
      the JSON must be byte-identical to before the deploy; you cannot check
      that after the fact.

      ```bash
      ssh root@65.21.229.167 \
        "curl -s -m 10 -H 'Accept: application/json' http://127.0.0.1:8095/app/flags" \
        > /tmp/app-flags.before.json
      ssh root@65.21.229.167 \
        "curl -s -m 10 -H 'Accept: application/json' http://127.0.0.1:8095/app/version" \
        > /tmp/app-version.before.json
      ```

- [ ] Note the current representation split, so §5 has a baseline to move:
      `ssh root@65.21.229.167 "curl -s http://127.0.0.1:8095/internal/metrics | grep responses_total"`
      Expect `repr="protobuf" 0` on a box that predates this change — and an
      *absent* series if the box predates the counter itself.

## 4. Deploy

```bash
bash scripts/deploy.sh
```

It backs up the source tree and retags the running image **before** touching
anything, syncs with `--delete`, gates on a fingerprint match before building,
builds with `--pull`, restarts **only** `go-api` (`--no-deps`), then verifies
`/health`, `/ready` and `/build`. Any failure triggers its own rollback.

**What that rollback does NOT restore.** `rollback()` (scripts/deploy.sh:182)
restores exactly two things: `vaultchat-backend-go/` from the tarball, and the
`vaultchat-go-api:latest` tag. Step 4 also syncs five other things that are
never rolled back —

| Synced at step 4 | Restored by rollback? |
|---|---|
| `vaultchat-backend-go/` | yes (tar) |
| `vaultchat-backend/migrations/` | **no** (merge, never removes) |
| `docker-compose.yml`, `docker-compose.prod.yml` | **no** |
| `monitoring/prometheus.yml`, `monitoring/alerts.yml` | **no** |
| `caddy/` | **no** |
| migrations *applied* at step 5 | **no** (stated in the script) |

So a failed deploy leaves the box running the **previous binary under the new
compose, Caddy and Prometheus config** — `rollback()` calls `$DC up -d` against
the files it just replaced. For this change that is benign (none of those five
differ). Re-read this table on any deploy where they do, because the script
will not warn you.

Do not add `--remove-orphans`. Compose knows ~19 services while 17 containers
run; that flag would delete both LiveKit servers and both egress containers —
every call and every broadcast, at once.

## 5. Verify protobuf is actually serving

`deploy.sh` proves the right *binary* is running. It does not prove
negotiation works. These two do, and **neither needs a token** — both endpoints
are deliberately unauthenticated.

**A Content-Type alone does not prove protobuf is serving.** `/app/flags` with
`VAULTCHAT_REMOTE_FLAGS` unset marshals to a **zero-byte body** — that is
correct (proto3 elides an empty repeated field, and
`app_flags_negotiation_test.go:241` pins it), but it means
`-o /dev/null -w '%{content_type}'` prints `application/protobuf` for a
0-byte 200 and for a healthy one alike. Always take the size, and prefer
`/app/version`, whose body is never empty (`update_url` always has a default).

```bash
ssh root@65.21.229.167

# Asks for protobuf. MUST print: application/protobuf, and a NON-ZERO size.
curl -s -m 10 -H 'Accept: application/protobuf, application/json' \
  -o /dev/null -w '%{content_type} %{size_download}\n' http://127.0.0.1:8095/app/version

# Same, and prove the bytes are really a protobuf rather than something that
# merely claims to be: update_url is field 3 (app_version.proto:26), so its tag
# byte is (3<<3)|2 = 0x1a, and the URL always has a default. `od` is in busybox
# and coreutils both; do not assume `xxd` is installed.
curl -s -m 10 -H 'Accept: application/protobuf, application/json' \
  http://127.0.0.1:8095/app/version | od -c | head -4
# expect readable "play.google.com/store/apps/details?id=com.vaultchat.app"

# /app/flags: content type AND size. A zero size here is only OK if
# VAULTCHAT_REMOTE_FLAGS is genuinely unset — check, do not assume.
curl -s -m 10 -H 'Accept: application/protobuf, application/json' \
  -o /dev/null -w '%{content_type} %{size_download}\n' http://127.0.0.1:8095/app/flags
ssh root@65.21.229.167 "docker exec vaultchat-go-api-1 printenv VAULTCHAT_REMOTE_FLAGS"

# Asks for JSON. MUST be byte-identical to the capture taken in §3.
curl -s -m 10 -H 'Accept: application/json' http://127.0.0.1:8095/app/flags \
  | diff - /tmp/app-flags.before.json && echo "JSON unchanged"

# The negotiation must NOT be over-matching: a plain client must still get JSON.
curl -s -m 10 -H 'Accept: application/json' \
  -o /dev/null -w '%{content_type}\n' http://127.0.0.1:8095/app/version
curl -s -m 10 -o /dev/null -w '%{content_type}\n' http://127.0.0.1:8095/app/version  # */*
# Both MUST print application/json. Anything else means every installed build
# just started receiving bytes it did not ask for.
```

**Then judge it from the metrics, which is the only check that covers the seven
AUTHENTICATED endpoints** — you have no token, so you cannot curl those:

```bash
ssh root@65.21.229.167 "curl -s http://127.0.0.1:8095/internal/metrics | grep responses_total"
```

`vaultchat_http_responses_total{repr="protobuf"}` must rise above the §3
baseline as real clients arrive, **and** `repr="json"` must keep rising too —
every currently installed build sends `Accept: application/json`, so a JSON
series that went flat would mean the negotiation is matching requests that did
not opt in. This counter is HTTP-only by construction; a CC-Wire send does not
move it.

Then through the edge, not just on loopback — a proxy that rewrites `Accept` or
`Content-Type` silently demotes every client to JSON:

```bash
curl -s -m 10 -H 'Accept: application/protobuf, application/json' \
  -o /dev/null -w '%{content_type} %{size_download}\n' \
  https://api.corefinite.com/app/flags
```

If the edge prints `application/json`, the deploy is fine and the *negotiation*
is being stripped. That is a Caddy problem, not a rollback trigger.

**But `content_type` alone cannot tell you WHICH failure it is**, and the two
have different consequences. Take the size as well and compare the two hops:

| loopback | edge | what happened | consequence |
|---|---|---|---|
| `protobuf N` | `protobuf N` | working | — |
| `protobuf N` | `json M` | the edge stripped `Accept` (or re-encoded) | harmless: every client falls back to JSON |
| `protobuf N` | `json N` | **the edge rewrote only the Content-Type** | the client sees `json`, gets protobuf bytes, `JSON.parse` throws |

The third row is the dangerous one and is invisible to the check as it was
written. The size is what separates it from row two. It is still not a data
hazard — `lib/api.ts` dispatches on the RESPONSE Content-Type, so the throw
lands on each caller's existing failure path (chat list keeps the cache, terms
fails open, flags keep the persisted snapshot) — but it is a silent,
total demotion that no metric would show, because the box would be counting
those responses as protobuf.

**Known gap, not fixed by this change: no `Vary: Accept`.** None of the nine
handlers sets it, and `/app/version` and `/app/flags` are unauthenticated GETs.
Caddy is not caching them today (`caddy/Caddyfile` has no cache directive and
reverse-proxies straight to `go-api:4000`), so this is latent rather than live.
It becomes real the moment a CDN, a corporate proxy or a caching layer sits in
front: one client's protobuf answer could be replayed to a client that asked
for JSON. Owned by `internal/routes/` — raise it there before anything is put
in front of this origin.

## 6. Rollback

Automatic on any failure inside `deploy.sh`. Later, manually:

```bash
ssh root@65.21.229.167
rm -rf /home/srihari/vaultchat-clean/vaultchat-backend-go
tar xzf /home/srihari/deploy-predeploy.<STAMP>/vaultchat-backend-go.tgz \
  -C /home/srihari/vaultchat-clean
cd /home/srihari/vaultchat-clean
docker compose -p vaultchat -f docker-compose.yml -f docker-compose.prod.yml \
  -f docker-compose.box.yml build go-api
docker compose -p vaultchat -f docker-compose.yml -f docker-compose.prod.yml \
  -f docker-compose.box.yml up -d --no-deps go-api
```

Two things this does not say for itself:

* **It rebuilds under whatever compose files are on the box now** — which are
  the ones step 4 synced, not the ones the old binary was deployed with. See
  the table in §4. For this change they are identical; check before assuming it
  on the next one.
* **Total only if step 5 printed `applied 0 migration(s)`.** If it applied any,
  the schema moved and nothing above moves it back — `135_unread_bump_authoritative.sql`
  in particular is a `CREATE OR REPLACE FUNCTION` with no down. See §2.1.

## 7. Known issues, none a blocker

1. **`strings.Contains(Accept, "application/protobuf")` treats
   `application/protobuf;q=0` — an explicit refusal — as a request for
   protobuf.** Present at every negotiation site. No shipping client sends
   `q=0`, so it is theoretical; it is also why the check belongs in one helper
   rather than copied per handler.

2. **Live sockets drop on restart.** `go-api` recreation reconnects every
   CC-Wire client. `deploy.sh` prints the count of in-progress calls before
   asking for confirmation. Deploy when that number is low.

3. **Persisted-cache compatibility is proven in CI, NOT on a device.** Every
   cache the nine endpoints feed has a suite pinning that the protobuf-decoded
   object is shape-identical to the JSON one — same keys, same runtime types,
   same null-vs-absent, which matters because `JSON.stringify` DROPS an
   `undefined` and a key the JSON path wrote as `null` would silently vanish:

   | Cache | Written by | Gate |
   |---|---|---|
   | chat list (SQLite `chats.data`) | `cacheChats` | `lib/chatsCacheRollback.selftest.ts` |
   | `vaultchat.remoteFlags.v1` | `remoteFlags.ts` | `lib/appFlagsNegotiation.selftest.ts` |
   | message rows (SQLite `messages`) | `cacheMessages` | `lib/chatsDeltaProto.selftest.ts` |
   | `vc_cache_dashboard` | `writeCache('dashboard')` | `lib/securityOverviewNegotiation.selftest.ts` |
   | backup meta | in-memory only | `lib/backupMetaNegotiation.selftest.ts` |
   | terms | in-memory only (no AsyncStorage) | `lib/termsNegotiation.selftest.ts` |

   What none of them can do is run a **genuinely older build's reader**: the old
   reader and the new one are the same source text, because no reader changed.
   The direction that is therefore still unproven is *previous APK reads a cache
   this build wrote*, and it needs two APKs on a handset. Do not describe
   rollback as "verified on device" until someone has done that.

## 8. After deploying — the measurement this unblocks

Cold start on the handset is currently **100% JSON**, because the negotiation
branches exist only in the working tree. The protobuf code does not execute.

A before/after is therefore only possible once this is deployed:

```
adb shell am start -W -S com.vaultchat.app/.MainActivity   # first frame
adb logcat -s ReactNativeJS | grep '\[perf\]'              # boot timeline
```

Report four milestones separately, never blended: first platform-drawn frame,
`chats_paint_cache`, CC-Wire authenticated, catch-up complete. Comparing a
first-draw number against a readiness number is what produced the earlier bogus
"859ms vs 13.4s" comparison.

The honest prior: the one large cold-start regression ever measured here —
13.4s — was caused by dialling an undeployed WebTransport endpoint, **not by
serialization**. It is entirely possible this migration moves cold start by
single-digit milliseconds. Measure before claiming.
