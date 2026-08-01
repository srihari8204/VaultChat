# Phase 6 — reach features: what shipped, what didn't, and why

Phase 6 in the improvement plan was four items (SFU, HTTP/3, CDN, protobuf
wire), all flagged High risk / new infrastructure. Only one of them is a code
change that can be written and verified without deploying infrastructure.
This file records the honest status of each so nobody has to re-derive it.

## SHIPPED — P6.1a: server-enforced mesh cap

**What:** `join_call` now refuses a join that would push a full-mesh group
call past `MESH_MAX_PARTICIPANTS` (default **5**, including the joiner) and
emits `call_full` instead. The client shows "Call is full" and backs out.

`internal/realtime/handlers.go` (`meshMaxParticipants`, the `join_call`
guard), `app/group-call-active.tsx` (`call_full` handler), tests in
`realtime_test.go`.

**Why this is the urgent half of P6.1.** `app/group-call-active.tsx` is a
pure mesh: every participant holds an `RTCPeerConnection` to every other and
uploads N-1 encoded streams. Cost per phone grows linearly, cost across the
call quadratically. Past ~5-6 on mid-tier mobile the uplink and encoder
collapse — and critically, the 7th joiner degrades the call for **everyone
already in it**, not just themselves. There was no cap anywhere in the
codebase (client or server), so nothing stopped a 10-person group from
trying. Refusing the join is strictly better than admitting it.

Note the cap is enforced **server-side** on purpose: a client-side check is
advisory (old builds, patched clients, races between two simultaneous
joiners). The server owns the roster — in cluster mode via Redis (P2.1) — so
it is the only place the check is authoritative.

**Raising it is an SFU decision, not a config decision.** The env var exists
to lower the cap, or to raise it *after* an SFU terminates media so phones
hold one upstream instead of N-1.

## NOT SHIPPED — P6.1b: the SFU itself

Adding LiveKit/mediasoup means standing up and operating a media server,
new TURN/SFU network topology, and rewriting the call screens from
peer-to-peer mesh to publish/subscribe. That is a multi-week infrastructure
project that cannot be written blind and cannot be validated in an
environment with no media server, no devices, and no network path. The mesh
cap above makes the *current* topology safe in the meantime; it does not
pretend to replace the SFU.

## NOT SHIPPED — P6.2: HTTP/3 + QUIC

**Blocked by the deployment shape, not by effort.** `caddy/Caddyfile` serves
`:80` plain HTTP and the compose service publishes `18080:80`. HTTP/3 runs
over QUIC, which is **TLS-only** — there is no such thing as HTTP/3 without
certificates. Enabling it requires, in order:

1. A real hostname + certificates in Caddy (`vaultchat.example { ... }`
   instead of `:80`), i.e. terminating TLS at Caddy rather than upstream.
2. Publishing **UDP** 443 (`"443:443/udp"`) as well as TCP — QUIC is UDP, and
   a TCP-only port mapping silently yields no HTTP/3 at all.
3. `servers { protocols h1 h2 h3 }` in a global options block.
4. Verifying the hosting firewall/load balancer forwards UDP/443 — many
   default configurations do not, which is the usual reason "HTTP/3 is on"
   but no client ever negotiates it.

Writing that config without knowing where TLS currently terminates in
production would produce a Caddyfile that either fails to start or silently
serves nothing. It needs the production topology, so it stays a documented
prerequisite rather than a guessed diff.

**Expected payoff when done:** QUIC removes TCP head-of-line blocking, which
mainly helps REST on lossy mobile networks (media/attachment fetches, catch-up
pages). Realtime already rides a long-lived WebSocket and benefits little.

## NOT SHIPPED — P6.3: CDN + direct-to-storage downloads

Uploads already go direct-to-store via presigned PUT (`POST /uploads/presign`,
`uploadsPresign`), so the upload half of this item is effectively done.

**Downloads are the remaining cost**, and they are not a config change:
`GET /uploads/{id}` (`internal/routes/uploads.go`, `uploadsGet`) is
`RequireAuth` and performs real per-request authorization — owner check, then
a `messages`/`chat_members` join proving the caller shares a chat with the
attachment, plus view-once state. Putting a CDN in front means moving that
authorization decision to a signed, expiring URL (and deciding how view-once
and revocation survive a cached edge object). That is an access-control
redesign; done carelessly it turns a per-request membership check into a
bearer URL that leaks media. Out of scope for a performance pass.

## NOT SHIPPED — P6.4: protobuf/msgpack wire

The E2EE wire is JSON today (`e2eeSession.ts`, plus hex-encoded ratchet state
in `e2ee.ts`). Switching serialization changes the *ciphertext envelope
format*, so it needs an explicit version tag, a read-both/write-old rollout
window, and on-device cross-version testing — the same discipline P3.1
followed to stay wire-compatible. It is worth doing (est. −20-40% wire bytes
and less per-message CPU), but it is a crypto-format migration, and shipping
it unvalidated risks exactly the cross-version breakage P3 avoided.

## Suggested order when you pick this up

1. **P6.2 HTTP/3** — smallest, once someone confirms the production TLS
   topology. Pure config.
2. **P6.4 protobuf wire** — self-contained, high measurable payoff, needs the
   parity-test discipline already established in `services/crypto/*.selftest.ts`.
3. **P6.3 CDN** — needs an access-control design decision first.
4. **P6.1b SFU** — largest; only when group calls above ~5 are a product
   requirement. Until then the cap holds the line.
