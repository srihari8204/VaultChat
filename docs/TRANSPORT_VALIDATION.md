# Optional WebTransport carrier

The Go API can serve authenticated CC-Wire over a dedicated HTTP/3 WebTransport
listener. It reuses the existing CC-Wire handshake, protobuf dispatch,
authorization, fan-out, limits and durable message handlers. WebSocket and
Socket.IO remain independent. HTTP/3 on the Caddy edge alone is not this carrier.

The listener is absent unless `CCWIRE_WEBTRANSPORT=1`. All three settings below
are required; there is no implicit public listener:

```text
CCWIRE_WEBTRANSPORT=1
CCWIRE_WT_ADDR=:4443
CCWIRE_WT_CERT=/run/secrets/ccwire-wt/tls.pem
CCWIRE_WT_KEY=/run/secrets/ccwire-wt/tls.pem
```

The process/container must have read access to the certificate and key, and
UDP/4443 must be separately published and permitted by the firewall.
The recommended PEM bundle contains both full chain and key. Files are re-read for each new TLS connection, allowing renewed certificates
without interrupting existing sessions. Invalid configuration fails startup
when the feature is explicitly enabled. No database migration is needed.

The optional [Compose overlay](../docker-compose.webtransport.yml) keeps its
UDP port on loopback `127.0.0.1:14443` unless `CCWIRE_WT_BIND=0.0.0.0:4443`
is explicitly persisted for rollout. Install and initially run
[the certificate hook](../scripts/http3-webtransport-certbot.sh) as root with
`RENEWED_LINEAGE=/etc/letsencrypt/live/api.corefinite.com`. It creates a dedicated
UID/GID1000 directory with mode0700 and bundle with mode0600, matching the Go
container user. The directory mount permits atomic certificate replacement;
the listener reads both certificate and key from one snapshot of the bundle.
Retain the existing nginx, TURN and Caddy certificate hooks.

Backend source required for this carrier: `internal/realtime/ccwire.go`,
`internal/realtime/ccwire_webtransport.go`, and `cmd/api/main.go`. The deployment
must build the reviewed backend source tree with its existing `Dockerfile`,
`go.mod` and `go.sum`; copying a source file alone does not update the running
binary. No module-version changes are needed. Include the existing CC-Wire
and new WebTransport overlays when recreating only `go-api`; retain its prior
image tag and omit the new overlay to roll the carrier back. Caddy HTTP/3
deployment is independent.

The native endpoint is `https://api.corefinite.com:4443/ccwire/wt/v1`. CONNECT
requires an `Authorization: Bearer …` header before upgrade; URL queries are
rejected. The existing pinned Go dependency
`github.com/zishang520/webtransport-go@v0.9.1` additionally requires
`Sec-Webtransport-Http3-Draft02: 1`. The Rust carrier pins `wtransport=0.7.2`
and explicitly supplies that header. Do not independently upgrade either
WebTransport draft version without rerunning interoperability tests.

After CONNECT, the client opens one reliable bidirectional stream and writes
the existing CC-Wire frames: one version byte, a four-byte big-endian payload
length, and protobuf payload. No extra length prefix is added. Both directions
use the same framing. The server checks the length before allocating, caps
frames at 2 MiB, applies negotiated limits in the shared session, requires a
ClientHello before operations, and times out silent streams. Datagram delivery
is not used. `ccwire_webtransport_connect` and `ccwire_webtransport_disconnect`
count accepted carrier sessions; existing CC-Wire counters still apply.

## Checks

From `vaultchat-backend-go`:

```sh
go test ./internal/realtime -run TestCCWireWebTransport -count=1
```

This uses a local UDP listener and generated test TLS identity to verify failed
authentication, successful TLS/CONNECT, split headers and pipelined
ClientHello/Ping frames, correct ServerHello/Pong replies, and bounded parsing.
Existing realtime tests exercise the shared permissions and message dispatch.

On 2026-09-15, the pinned Go fork 0.9.1 and Rust wtransport 0.7.2 passed real
interoperability with a generated CA and separate server certificate: unknown
CA and invalid JWT rejected; trusted TLS and authenticated CONNECT accepted;
split and pipelined ClientHello/Ping produced ServerHello and matching Pong;
cancellation closed the carrier. HTTP/3 header names must be lowercase in the
Rust request builder, which does not normalize them automatically. This test
retained strict certificate verification throughout.

For cross-language checks, create a temporary directory and set
`CCWIRE_WT_INTEROP_DIR` to its absolute path in both shells. Start
`go test ./internal/realtime -run '^TestCCWireWebTransportInteropServer$' -count=1 -v`.
It writes `fixture.json` and `ca.pem` containing only a local test identity,
then waits for the Rust client to write `done`. Run the Rust ignored
`go_webtransport_interop` test with its `webtransport` feature. This verifies
the exact Go/Rust versions; it is not a production or phone test.

Before enabling the native endpoint, verify its CA chain, authorization,
message acknowledgement, reconnect and WebSocket fallback on the phone.
Keep the app endpoint opt-in until those checks pass. Browser WebTransport
cannot set an arbitrary Authorization header through its standard constructor,
so this endpoint currently serves the native client only.
