# Sync, CC-Wire, protobuf and server audit — 2026-09-15

## Result

Several reproduced defects are fixed locally. This is not a claim that every
repository bug is fixed or that CC-Wire/Rust messaging is deployed or verified
on a phone. The working tree contained substantial existing changes; those
were retained. No application deployment, database migration or data restore
was performed during this audit.

## Local repairs

- Mutation sync checkpoints each successfully stored page, including short
  final pages and the 20-page limit. Server-issued timestamp/message-ID cursors
  preserve PostgreSQL timestamp precision and drain timestamp ties. Invalid
  cursors return 400. Requests retain the legacy timestamp parameter for
  rollback compatibility. An old server cannot drain more than 500 mutations
  sharing one timestamp; the fallback stops without advancing past that tie.
- Chunked encrypted storage serializes reads, writes and deletion across
  wrappers sharing the same backing adapter. Existing generation-based writes
  preserve the old value until the new head commits. Backup export propagates
  session read errors instead of silently omitting sessions.
- Group plaintext caching records the ciphertext body. Edited messages bypass
  untagged legacy cache entries and the previous plaintext hydration shortcut.
  Unedited legacy history remains readable.
- CC-Wire catch-up passes validated per-chat positions to the canonical SQL
  query. Chat and cursor filtering happens before LIMIT, preventing unrelated
  or already-synced messages from permanently occupying a page. In mixed cold
  and warm batches, cold floors/delivery filters apply only to cold scopes.
- Cold-sync pages now carry a server-authenticated, account-bound continuation.
  The client persists it only after the page is stored and clears it after the
  terminal page, so reconnects cannot accidentally widen an unfinished cold
  sync into unrestricted history.
- The existing CC-Wire protobuf now carries an opaque mutation continuation.
  Go returns edits/deletes with the existing CC-Wire mutation bodies, while the
  TypeScript and Rust codecs preserve uint64 values and unknown fields. Peers
  that omit the new fields retain their previous behavior.
- Message-send metrics identify the actual HTTP submission path. A successful
  parallel CC-Wire handshake no longer relabels HTTP sends as CC-Wire.
- The Go protobuf body reader rejects overflowing uint64 varints and invalid
  cursor field zero, and skips legal unknown fixed32/fixed64 fields.
- ClientHello device ID forwarding is covered by a regression. It is install
  metadata, not proof that a device belongs to the account.
- A safe-by-default Caddy HTTP/3 edge overlay binds loopback staging ports,
  retains TCP HTTP/1.1 and HTTP/2, publishes a UDP listener, preserves the HTTP
  redirect and signed MinIO media path, and includes explicit rollback steps.
  It was not activated in production.

## Verification

- Full JavaScript run passes: 284/284 suites, including the authenticated
  cold-sync continuation and cursor codec regressions.
- Type checking passes after correcting the new test's Node URL import.
- Lint exits successfully: 0 errors, 279 warnings across the repository.
- Go routes, realtime and CC-Wire package tests pass. New pagination tests ran
  against a disposable localhost PostgreSQL 18 cluster with temporary tables:
  501 timestamp ties, cursor validation, unrelated-chat starvation, mixed
  cold/warm scopes, continuation filtering and forged-token rejection. The
  cluster was stopped afterward.
- Client sync regression covers more than 10,000 mutations, storage failure,
  timestamp ties and old-server fallback. Storage race and group edit/replay
  regressions pass.
- Rust networking: all 12 localhost WebSocket integration tests pass, including
  handshake, bearer authentication, framing, heartbeat, backpressure and close.
- Rust cursor protobuf tests and Go/TypeScript codec parity checks pass. The
  HTTP/3 overlay's structural and merged Compose checks pass. A live Caddy
  parser/protocol smoke test remains blocked locally because Docker Desktop is
  unavailable.
- `git diff --check` passes; Git reports line-ending conversion notices.

Local tests do not establish production delivery, Android background recovery,
or authenticated interoperability between a phone and the deployed Go server.

## Server observations

SSH key authentication to `srihari@65.21.229.167` works.

- Public `/build` reported source `7017c4e6ecb929a2`, built
  `2026-09-14T21:28:59Z`, Go `go1.26.8`. The API container had zero restarts.
  Its Compose working directory is `/home/srihari/vaultchat-clean`, which has
  no Git metadata. A host source file is therefore not independently sufficient
  to prove the exact running binary contents.
- `CCWIRE_WS` is unset in the API container, and public `/ccwire/v1` returns
  404. CC-Wire is not enabled on this deployment.
- Production nginx is 1.24.0 with HTTP/2 but without an HTTP/3/QUIC module, and
  no process listens on UDP/443. Adding an nginx `quic` directive would fail;
  the prepared Caddy overlay is the reversible path to an HTTP/3 trial.
- The host deployment source already scopes poll-vote lookup by chat and
  message ID. The attachment's unscoped-query finding is stale for that source.
- Redis accepts unauthenticated PING inside its container. Its published port
  is `127.0.0.1:16379`, not a public bind; it also uses the shared
  `vaultchat_default` network. This is an internal access-control concern, not
  evidence of public Redis exposure or access from every container on the host.
- PostgreSQL role `vaultchat` has superuser and RLS-bypass privileges. Active
  database connections use that role. The process owner of each connection was
  not independently attributed.
- Disk use was 27%. A filtered recent API log scan found no panic/fatal/error
  matches; this does not establish health of every endpoint.
- Backup script retains age-only local `vaultchat-*.sql.gz` deletion and remote
  14-day pruning. Recent logs report successful off-site uploads; remote object
  inventory and restore integrity were not independently verified.

### Backup preserved

The September 12 archive passes gzip integrity checks. Its larger size alone
does not prove completeness or that the September 13 reset was accidental.
A non-destructive copy was created outside the configured prune directory:

`/home/srihari/vaultchat-backup-hold-20260915/pre-reset-20260912.sql.gz`

The hold directory has mode 0700. Original and copy are 3,630,256 bytes and have
the same SHA-256:

`c4d2db0b87aea53e0e937317b7aa130887ba1abd6f311914da3a0126b3f71155`

The original was retained. This protects against the current automatic prune,
not disk loss. No user data was restored or transferred to another service.

## Remaining fix plan, in order

1. **Recovery:** independently inventory and restore-test encrypted off-site
   archives into an isolated database; preserve a verified pre-reset archive
   off-site under a retention exception. Add retention tests and backup size/
   restore alerts. Do not restore into production without a recovery decision.
2. **HTTP/3 rollout:** run the Caddy parser and loopback protocol probes on a
   Docker-capable host, then test signed media and Socket.IO through the staged
   edge. Open UDP/443 and switch the public listener only after those checks;
   retain nginx as the rollback path.
3. **Server hardening:** inventory all Redis clients, stage authentication and
   narrower networks, then roll out matching client credentials together.
   Inventory database queries/policies and introduce a least-privilege runtime
   role with separate migration/system access. Switching credentials or revoking
   privileges immediately would risk breaking current services.
4. **Wire Rust and WebTransport into the app:** connect the existing Rust
   WebSocket runtime to
   the native mobile bridge and make one component own submission and delivery.
   Currently `lib/ccwire/transport.ts` supervises a TypeScript handshake sidecar:
   outbox sends still use HTTP and inbound events still use Socket.IO. A Rust
   crate passing tests does not mean the app calls it. Add WebTransport only
   after that shared client path exists and interoperability passes.
5. **Acceptance and rollout:** run authenticated Go/Rust interoperability and
   two-phone tests for text/media, edits/deletes, receipts, reconnect, Wi-Fi ↔
   cellular changes, background/foreground, duplicate suppression and rollback.
   Build the APK and stage the backend only after these gates. Enable CC-Wire
   gradually with the existing fallback retained until acceptance is complete.

Items 1–5 are remaining deployment, hardening and device-verification work.
Production application
configuration and flags were left unchanged during this audit.
