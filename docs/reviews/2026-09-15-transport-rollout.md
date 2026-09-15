# Transport rollout follow-up — 2026-09-15

This follows the earlier sync audit. Written code, server deployment and phone
verification are recorded separately. Existing REST and Socket.IO functionality
remains available during the staged transport rollout.

## Implementation

- Android exposes verified Rust WebSocket I/O through an Expo native plugin.
  The existing TypeScript CC-Wire client owns framing, handshake and reconnects.
- Eligible encrypted text submissions use protobuf SubmitMessage/Ack. Sequential
  HTTP fallback preserves the same client ID and ciphertext. Media, replies and
  unsupported metadata retain REST; Socket.IO remains the inbound event owner.
- Diagnostics report actual carrier, submissions, acknowledgements and fallback.
- Fixed two additional reconnect failures: a timeout on initial offline startup
  previously stayed disabled for the process, and a later reconnect could wait
  indefinitely for ServerHello. Each dial now has a handshake deadline and a
  generation guard against late token completion. Network/foreground signals
  can retry transient failures with a 30-second cooldown; fatal/auth refusals
  remain closed, and logout cancels recovery. Five focused suites passed,
  including duplicate-owner and Socket.IO lifecycle regressions.
- The Expo transport percentage now uses a statically inlined environment
  reference; the production-transform regression covers release bundling.
- Optional Rust/Go WebTransport uses a reliable stream and the existing CC-Wire
  session core. Real Go/Rust interoperability passed, including strict TLS,
  rejected invalid authentication, split/pipelined frames and cancellation.
  The app endpoint remains opt-in for device acceptance.
- The first phone build exposed a missing default Rust TLS provider and aborted
  during native startup. The corrected build explicitly enables the provider
  and contains Rust unwinding at the JNI boundary. A default-feature test now
  reaches the production WSS endpoint through verified TLS and observes the
  expected 401 for an invalid test token, without a panic.

## Server evidence

- Enabled CCWIRE_WS on the existing API image. Health passed and unauthenticated
  `/ccwire/v1` returned 401. Existing image retained as
  `vaultchat-go-api:pre-ccwire-20260915` for rollback.
- Deployed additive Caddy on UDP/8443, retaining nginx TCP/80 and TCP/443.
  External HTTP/3-only probing from the Windows PC passed HTTP/3.0, ALPN h3,
  status 200 and certificate verification. The API nginx vhost now advertises
  `h3=":8443"; ma=300`; ordinary HTTPS health still passes. Certificate-renewal
  reload hook installed. No nginx version replacement was necessary.
- Initial external UDP/443 attempts exposed existing PREROUTING redirects to
  TURN/3478. A same-server probe bypassed these incoming-packet rules and gave
  misleading reachability evidence. Packet metadata and NAT inspection found
  the conflict; both call-relay redirects were preserved. Moving only the
  additive edge to UDP/8443 resolved the real external HTTP/3 probe.
- Built isolated Go candidate image `transport-candidate-20260915`, source
  fingerprint `859b143426237b6b`. Realtime, routes, CC-Wire and API regression
  packages passed inside an isolated container with shared fixtures mounted
  read-only. Database-dependent cases require the separate PostgreSQL checks
  described in the original audit; this container had no network access.
- Deployed that candidate through `docker-compose.transport-20260915.yml`.
  Direct and public health/readiness, build fingerprint and unauthenticated
  CC-Wire 401 checks passed. Only go-api restarted; no migrations ran.
  Durable source: `/home/srihari/vaultchat-releases/transport-20260915/source`.
  Rollback: `bash /home/srihari/vaultchat-releases/transport-20260915/rollback.sh`
  with sudo. Include the dated compose override in future API compose commands.
- Enabled the optional Go WebTransport listener on UDP/4443 using the same
  tested image, with a nonroot-readable atomic certificate bundle and renewal
  hook. Direct/public health and readiness still pass. Include
  `docker-compose.webtransport.yml` after the dated override to retain it;
  omit that final overlay to disable only WebTransport. Phone acceptance is
  recorded separately below.
- An external Rust WebTransport probe using the production TLS configuration
  and a deliberately invalid JWT reached the endpoint in 1.2 seconds and
  returned `SessionRejected`, consistent with authentication enforcement.
  Certificate validation and QUIC connectivity passed; this probe does not
  establish a successful authenticated phone session or expose HTTP status.
- Actual attachments use Cloudflare R2 directly. The legacy MinIO path is not
  their current delivery route; no bucket or user storage was modified.

## Local validation

- Final full JavaScript run passed 288/288 suites. Two earlier stale-test wiring
  failures were corrected to exercise the real submission coordinator. The full
  rerun includes DID crypto and reconnect recovery regressions. No conversation
  or encryption assertion was removed.
- Final type checking passed after the reconnect fixes. Full lint passed with
  0 errors and 279 warnings; the later reconnect files passed focused lint with
  0 errors and 19 warnings.
- Backend endpoint/socket contract inventory passed. Migration runner skipped
  because the local database credentials were unavailable; no migration ran.
- Transport OpenSpec strict validation and diff whitespace checks passed.
  Repository-wide strict validation passed 32/33 items: the unrelated
  `fix-presence-publish-stall` change has no delta specification. It was left
  untouched rather than inventing requirements for that separate change.
- The optional ARM64 Rust archive compiled successfully after the TLS fix.

## Device acceptance

Final artifact: `android/app/build/outputs/apk/release/app-release.apk`, version
1.2.10/code26, ARM64, 102,738,922 bytes. The final reconnect-fix build succeeded
and APK Signature Scheme v2 verification passed. SHA-256:
`b310494c89a7172dd229f6ff678f411ebb6c82b22daa1840d58a84e8817a5fcb`.
This final artifact was not installed because the Honor had disconnected.

The corrected optional-WebTransport ARM64 APK (1.2.10/code26) built successfully
and was installed over the existing Honor app without clearing data. Cold launch
completed in 1.8 seconds and the app process remained alive. Live diagnostics
reported cohort enabled, CC-Wire ready, carrier `rust-ws`, Socket.IO connected,
and protobuf counters 0/0. This verifies the Rust WSS integration and fixes the
earlier native startup abort. It does not yet prove a protobuf message Ack or
WebTransport on the phone; the latter selected the WSS fallback. Interactive
chat acceptance could not proceed while the phone was locked; it subsequently
disconnected from ADB during the final reconnect-fix build. No labelled Leo
messages were sent, edited or deleted, and no second-device result is claimed.
The earlier crash-corrected, pre-recovery-fix APK remains installed on Honor.

One Honor ELI-NX9 is available. The user authorized clearly labelled tests in
Leo's chat and confirmed that no second signed-in device is available. The
automated two-user encryption/conversation tests do not substitute for a real
two-phone delivery, receipt and decryption test.

## Audit follow-up

- The previously reported delivery stall has cleared: the original messages
  remain undeleted and unexpired, and the recipient's delivered/read cursors
  have advanced beyond them. This is not proof of device-side decryption.
- Redis authentication requires coordinated updates to API, games, egress and
  LiveKit clients. Both Redis instances still accept unauthenticated PING.
- The active database runtime role still has superuser/BYPASSRLS privileges.
  Existing app/system roles can support a staged change after compatibility
  testing. No privileges were revoked during this transport rollout.
- The preserved pre-reset archive still matches its recorded hash and gzip
  integrity check. Off-site inventory and an isolated restore remain unverified.
- Device enrollment, iOS Rust integration and the two-phone acceptance matrix
  remain distinct from the Android transport work.

## Existing identity features

The server-issued contact VaultID, Ethereum-format local VaultID, and Ed25519
`did:key` screen are separate implementations. The DID module creates a local
key, shares the public identifier and performs a local signing check. No login
or messaging call site for its `signWithDid` helper was found. Creation of a DID
does not by itself decentralize account authentication, message delivery or
storage, nor verify the user's real-world identity.

Fixed its local verification check to require that the stored secret derives
the displayed DID, public key and fingerprint. Previously it only checked a
signature against the public key derived from that same secret, allowing a
stale displayed identity to appear verified. Existing identity keys and storage
formats are preserved.
