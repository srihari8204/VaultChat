# Running the LiveKit SFU on the existing box

Everything is already in the repo — a compose service, a config file, a Caddy
route and the backend env wiring. This is the order to switch it on, and what
each step is actually for.

Nothing here starts by default. `livekit` is behind the `sfu` compose profile,
and the backend answers `503` with a reason until `LIVEKIT_API_KEY` is set. The
mesh group call keeps working throughout.

---

## Why one container is enough

LiveKit needs a cluster when room state has to be shared across nodes — that is
what its Redis backend is for, and it starts mattering in the low thousands of
concurrent participants. Below that a single process is not a compromise, it is
the correct deployment.

The load profile also helps: **an SFU forwards, it never transcodes.** With frame
encryption on (`docs/SFU_SPIKE.md`) it *could not* transcode — the payloads are
ciphertext. So no encoder ever runs on this box. What it consumes is **egress
bandwidth**, roughly 600 kbps per forwarded stream:

| Call size | Publishers | Egress |
|---|---|---|
| 5 — today's mesh cap | 5 | ~15 Mbps |
| 10 | 10 | ~54 Mbps |
| 25 | ~6 active | ~90 Mbps |
| 64 | ~6 active | ~230 Mbps |

Hetzner includes 20 TB/month on most plans, so the bandwidth is very likely free.

> **The real risk of same-box is co-tenancy, not capacity.** 230 Mbps of media
> and its interrupt load sit next to Postgres, Redis and Kafka. Watch Postgres
> latency during your first large call — the Grafana "Calls" row and the existing
> p95 panel are on the same dashboard for exactly this comparison. If the
> database wobbles, move LiveKit to its own small instance; nothing in the config
> below changes except `LIVEKIT_URL`.

---

## 1. Generate keys

```bash
docker run --rm livekit/livekit-server generate-keys
```

Two values: an API key and a secret. They go in **three** places, and all three
must match or tokens verify against nothing:

```bash
# vaultchat-backend/.env
LIVEKIT_KEYS="APIxxxxxxxx: secretsecretsecret"      # the SFU: "key: secret"
LIVEKIT_API_KEY=APIxxxxxxxx                          # the backend signs with these
LIVEKIT_API_SECRET=secretsecretsecret
LIVEKIT_URL=wss://your.domain/livekit                # what the CLIENT dials
```

`LIVEKIT_URL` is handed to the app, so it must be the **public** address. An
in-network name like `http://livekit:7880` works from the backend and fails on
every phone.

## 2. Open the firewall

RTC does not go through Caddy — proxying media would put the reverse proxy in the
path of every packet, which is the opposite of what an SFU is for. These reach
the host directly:

| Port | Why |
|---|---|
| **7882/udp** | media. Single port rather than a 50000–60000 range: one firewall rule to reason about instead of fifty thousand, on a box that also runs coturn |
| **7881/tcp** | fallback for networks that block UDP — corporate wifi, some carriers. Without it those users cannot join at all, and it looks like "the call never connects" |

`7880` stays **closed** — Caddy proxies signalling at `/livekit`, so it is reached
over your existing TLS certificate and needs no hostname of its own.

```bash
ufw allow 7882/udp
ufw allow 7881/tcp
```

## 3. Start it

**Validate the proxy config first.** The Caddyfile gained a `/livekit` route and
its three blocks were made uniform `handle` blocks; that change could not be
verified in the environment it was written in (no Caddy binary, no Docker
daemon), so check it before restarting the thing that serves all your traffic:

```bash
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
```

Then:

```bash
docker compose --profile sfu up -d livekit
docker compose restart caddy go-api        # pick up the route + the new env
docker compose logs -f livekit             # expect "starting LiveKit server"
```

Confirm signalling is reachable through Caddy — this should be an HTTP 200 with
LiveKit's version banner, **not** a 502:

```bash
curl -fsS https://your.domain/livekit/
```

A 502 means Caddy cannot reach the host — check the `extra_hosts` mapping on the
caddy service. It is there because `livekit` uses `network_mode: host` (RTC needs
the host's real address for its ICE candidates), and on Linux
`host.docker.internal` does not resolve without it.

## 4. Verify the backend agrees

With `CALL_SESSIONS` on and a call in progress:

```
POST /calls/{id}/sfu-token   → 200 { token, url, room, role }
```

Before the keys are set it returns `503` and increments
`vaultchat_events_total{event="call_sfu_unconfigured"}` — that counter is on the
Grafana **Calls** row, and a non-zero rate after this deploy means the env did
not reach `go-api`.

Paste the token into <https://jwt.io> and read the `video` claim. An audience
member's should carry **no** `canPublish` and **no** `canPublishSources` — that
is the whole role model arriving at the media layer, and it is asserted by
`internal/livekit/token_test.go`.

---

## What is still missing after this

The server is only half of C. `SfuTransport` — the client actually joining the
room — is **not written yet**, deliberately: a transport with nothing to connect
to cannot be verified, and this codebase already had enough code that was built,
correct and dark.

Once this box is up, that changes: C4 becomes testable, and C5 (64 participants,
simulcast, active speaker) and C6 (frame encryption wired to the per-call key
`lib/callCrypto.ts` already mints) follow it.

So the honest sequence is: stand this up, confirm step 4 returns a token, then
C4 gets written against a server that answers.

## Rolling it back

```bash
docker compose --profile sfu down livekit
```

Then unset `LIVEKIT_API_KEY` and restart `go-api`. The token endpoint returns to
`503`, and group calls fall back to the mesh with its 5-participant cap — which
is exactly where they are today. Nothing else in the stack is touched.
