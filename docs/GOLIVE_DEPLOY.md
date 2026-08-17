# Go Live Broadcasting — deploying the separate LiveKit

Go Live runs its **own** LiveKit deployment. It shares no credential, port, room
namespace, Redis keyspace, webhook, health check or log stream with the SFU that
serves 1:1 and group calling (`docs/SFU_DEPLOY.md`). This file covers only the
Go Live half; nothing in it applies to the calling SFU, and nothing here should
be run against it.

## Why separate at all

Broadcasting and calling have opposite risk profiles on one machine. A broadcast
is unbounded, unencrypted, and drags egress — headless Chrome plus ffmpeg, the
only CPU-bound thing in the stack — along with it. A call is small,
frame-encrypted, and must not go down. Sharing one SFU meant a viral stream could
take calling with it, and a leaked broadcast key was also a calling key.

## The dependency table

| Component | Existing calling | Go Live |
|---|---|---|
| SFU service | `livekit` | `golive-livekit` |
| Egress service | `egress` | `golive-egress` |
| Config file | `livekit/livekit.yaml` | `livekit/golive.yaml` |
| Signalling port | 7880 | **7890** |
| RTC TCP | 7881 | **7891** |
| RTC UDP | 7882 | **7892** |
| Credentials | `LIVEKIT_*` | `GOLIVE_LIVEKIT_*` |
| Room namespace | `call-<call-id>` | `golive_<broadcast-id>` |
| Redis keyspace | db 0 | **db 3** |
| Webhook | `/internal/livekit/webhook` | `/internal/golive/webhook` |
| Caddy signalling path | `/livekit` | `/golive-livekit` |
| Health | `GET /health` | `GET /golive/health` |
| Log prefix | `[call]`, `[broadcast]` | `[GOLIVE]` |
| Metrics prefix | `call_*`, `broadcast_*` | `golive_*` |
| Compose profile | `sfu` | `golive` |

Any overlap in the credential row is a defect. The backend detects it
(`golive.Config.SameProjectAsCalls`) and refuses to start broadcasts, and
`GET /golive/health` reports `sharesCallingProject: true`.

## Environment

Set these on `go-api`. **There is no fallback**: absent, `POST /broadcasts`
answers 503 rather than quietly using `LIVEKIT_*`.

```
GOLIVE_LIVEKIT_API_KEY      # its own key — NOT the calling one
GOLIVE_LIVEKIT_API_SECRET   # its own secret — NOT the calling one
GOLIVE_LIVEKIT_URL          # what the CLIENT dials, e.g. wss://<host>/golive-livekit
GOLIVE_LIVEKIT_KEYS         # "key: secret" for the golive-livekit container
GOLIVE_ROOM_PREFIX          # optional, default golive_
GOLIVE_HOST_GRACE           # optional, default 90s — host-disconnect grace
GOLIVE_HOST_REAPER=off      # optional kill switch for the grace sweep
GOLIVE_EGRESS_WS_URL        # optional, default ws://host.docker.internal:7890
GOLIVE_EGRESS_CPUS          # optional, default 2
GOLIVE_EGRESS_MEMORY        # optional, default 2g
```

Object storage (`S3_*`, `BROADCAST_BUCKET`) is deliberately shared with the rest
of the stack. A bucket is not a media server, and the segment layout must match
what `internal/livekit/egress.go` signs its `segment_outputs` with.

## Steps

1. **Generate a key pair of its own.** Do not reuse the calling one.

   ```
   docker run --rm livekit/livekit-server generate-keys
   ```

   Put the pair in `GOLIVE_LIVEKIT_KEYS` and the same key/secret in
   `GOLIVE_LIVEKIT_API_KEY` / `GOLIVE_LIVEKIT_API_SECRET`.

2. **Edit `livekit/golive.yaml`.** The `webhook.api_key` field is a placeholder
   and must be replaced with the literal `GOLIVE_LIVEKIT_API_KEY` value. LiveKit
   reads this file as plain YAML and does **not** expand `${VAR}` — a variable
   reference there is delivered as literal characters.

3. **Apply the migration.**

   ```
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f vaultchat-backend/migrations/105_golive_visibility.sql
   ```

   Idempotent; safe to re-run. Adds `visibility` and `host_left_at`, and replaces
   079's `USING (TRUE)` select policies so private streams are not world-readable.

4. **Open the firewall** for UDP 7892 and TCP 7891, alongside calling's
   7882/7881. Media does not go through Caddy.

5. **Start the two services, BY NAME.**

   ```
   docker compose --profile golive up -d golive-livekit golive-egress
   ```

   > Never pass `--remove-orphans` on prod. It deletes running services that are
   > not in the composed set, and the live `livekit-egress` container is one.

6. **Redeploy `go-api` and `caddy`** so the new environment and the
   `/golive-livekit` route take effect.

7. **Verify.**

   ```
   curl -s localhost:14000/golive/health | jq
   ```

   Expect `"status": "GOLIVE_HEALTHY"` and `"sharesCallingProject": false`.
   Anything else, and `livekit.error` says which half is wrong.

## Worldwide streaming — putting a CDN in front

The origin serves playback at `/broadcasts/{id}/hls/…`. Two things had to change
before a CDN could do anything useful there, and both are now in
`internal/routes/broadcast_hls.go`:

- **The ticket is bucketed.** It used to be `now + 24h`, so every viewer and
  every playlist refresh produced a *different* URL for the *same* segment. A CDN
  would have cached each separately and missed on all of them. The deadline is
  now rounded up to the next hour, so every viewer of a broadcast requests an
  identical URL — one origin fetch per segment, globally.
- **Segments are `public`, not `private`.** `private` forbids every shared cache;
  with it set, a CDN in front of this origin would refuse to store a single
  segment. Access control is unaffected — the signed ticket in the query string
  is still the credential, and the bucket is still private.

Segments: `public, max-age=31536000, immutable`. Playlists: `public, max-age=2` —
long enough to collapse a thundering herd into one origin fetch, well inside the
4-second segment duration so no viewer sees a stale live edge.

To enable it: point a CDN hostname at the API origin, cache on the **full URI
including the query string** (the ticket is part of the cache key), and set

```
BROADCAST_CDN_BASE=https://stream.<your-domain>
```

Nothing else changes — `livekit.PlaybackBase()` already prefers it, and every
playback URL is minted from that one function.

**Still single-region:** the SFU itself is one box. Viewers are global once the
CDN is in front, because they are served HLS from the edge. *Hosts and co-hosts*
still dial Hetzner directly, so a host in another continent gets that RTT. Fixing
that means a second `golive-livekit` in another region plus LiveKit's multi-node
Redis mode — out of scope here, and not needed until hosts are geographically
spread.

## Android screen share

Go Live has **its own** foreground service, `GoLiveForegroundService`
(`plugins/withVaultChatGoLive.js`). It is not optional and it is not shared with
calling:

- Android 10+ refuses `MediaProjection.createVirtualDisplay()` unless a
  foreground service of type `mediaProjection` is running. Without one the screen
  track publishes, subscribers subscribe, and the encoder emits `encoded=0
  size=0x0` — no frames at all.
- Android 12+ revokes mic and camera capture seconds after the app is
  backgrounded, so a host who checks a message goes silent and black while every
  viewer still sees LIVE.
- VaultChat sets `FLAG_SECURE` on its activity, and a secure window **cannot be
  captured** — the projection runs, consent succeeds, the encoder gets nothing.
  `lib/golive/native.ts` clears it before a share and restores it on every exit
  path, including a failed or declined one.

`CallForegroundService` solves the same problems for calls, but it is started by
the call lifecycle and is **not running** during a broadcast.

After changing any of this: `npx expo prebuild -p android`, then rebuild.

**iOS screen share is NOT implemented.** It requires a Broadcast Upload Extension
— a separate binary target with its own bundle id and app group — which a config
plugin cannot add. Camera and microphone broadcasting work on iOS today.

## Verifying the isolation

Run a 1:1 call, a group call and a broadcast at the same time, then:

```
docker compose logs golive-livekit | head        # Go Live only
docker compose logs livekit        | head        # calling only, unchanged
docker compose stop golive-livekit               # calls must keep working
curl -s localhost:14000/health                   # still 200
curl -s localhost:14000/golive/health            # now GOLIVE_UNHEALTHY, 503
docker compose start golive-livekit
```

A Go Live outage must never change how calling reports itself. That is the
requirement, and `GET /golive/health` never pings the calling cluster — see
`internal/routes/golive.go`.

## Rollback

`docker compose stop golive-livekit golive-egress` — broadcasting returns 503 and
says so in the UI; calling is untouched. The migration needs no rollback: leaving
`visibility` in place with every row `'public'` is exactly the pre-105 behaviour.
