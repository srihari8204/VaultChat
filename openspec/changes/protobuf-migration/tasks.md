# Tasks — protobuf-migration

Levels, per `openspec/config.yaml`: **written** → **deployed to prod** (file
copy, not git) → **device-verified**. No task here is past *written* until it
says so. The September 20 follow-up explicitly authorizes running all tests
and deploying the reviewed backend fixes when needed. Packaging and production
data/schema changes are not part of this backend repair deployment.

## Wave 0 — Evidence and planning

- [x] 0.1 Verify the baseline. HEAD `3093b42`, branch `hetzner-deploy`, 0 dirty
      files. The ~312-file hazard no longer exists.
- [x] 0.2 Establish that production runs Go only (`docker-compose.prod.yml`:
      caddy → go-api) and that `vaultchat-backend/contract/endpoints.json`
      describes the undeployed Express app.
- [x] 0.3 Audit schemas and codecs. Result: no generation anywhere; four
      independent hand-written readers with differing strictness.
- [x] 0.4 Audit the Go loopback and middleware. Result: no reusable application
      operation exists; eleven gates are inherited through the REST handler.
- [x] 0.5 Audit bridge, identifiers, money, timestamps, HTTP surface.
- [x] 0.6 Audit E2EE, storage, backups, attachments.
- [x] 0.7 Resolve D1–D4 and record retractions (money; the E2EE transcript).
- [x] 0.8 Write `proposal.md`, `design.md`, `specs/protobuf-serialization/spec.md`,
      this file. Validate with `openspec validate protobuf-migration --strict`.

## Wave 1 — Codec foundation  ← THE FIRST APPLY BATCH

Entry: this plan authorized. Exit: generation reproducible, fixtures pass in
both languages, regeneration proven to be a no-op.

- [x] 1.1 **Prove the toolchain before depending on it.** Generate one message
      (`Capabilities`) with `@bufbuild/protoc-gen-es@^1.x`, import the output in
      a node selftest, and confirm it loads. Records whether v1 output is usable
      under this repo's TS config. If it is not, stop and re-decide D1 — do not
      work around it.
      *Owned files: `proto/ccwire/v1/capabilities.proto` (read-only), one new
      selftest, `package.json` devDependencies.*
- [x] 1.2 Declare `@bufbuild/protobuf` as a direct dependency pinned to the
      already-resolved `1.10.1`. Adds no shipped bytes; makes the existing
      transitive dependency explicit. Add `google.golang.org/protobuf` +
      `protoc-gen-go` to `go.mod` at pinned versions.
      *Owned files: `package.json`, `package-lock.json`, `go.mod`, `go.sum` —
      lead only.*
- [x] 1.3 Add the generation command and a `--check` mode that fails when
      regeneration would change a file. Wire `--check` into `npm test` via the
      existing runner rather than a new CI job.
- [x] 1.4 Generate TS and Go codecs for the seven existing `.proto` files. Do
      not delete the hand-written codecs.
- [x] 1.5 **Reconcile generated against hand-written using the existing
      fixtures.** Run `lib/ccwire/__vectors__/codec.json` and `adversarial.json`
      through the generated codecs. Compare decoded semantics and explicit byte
      contracts separately — a raw byte diff alone is not a verdict.
- [x] 1.6 Record every divergence found. The four already known, to be confirmed
      or refuted by 1.5:
      - `AppEvent.event` bounded at 4096 in TS (`codec.ts:502`) vs **64** in Go
        (`ccwire_app_events.go:157-158`); UTF-8 fatal in TS, unvalidated in Go.
      - `max_batch_items` = 256 enforced in Go only; TS bounds cursors at 1024
        (`codec.ts:760`).
      - `max_message_body_bytes` is `uint64 [jstype=JS_STRING]` but TS reads it
        through a 32-bit mask (`client.ts:466` → `:247`).
      - Go writes `Ack.seq`/`server_ts_ms` non-canonically
        (`ccwire_messages.go:358-360`), breaking the byte-identity property
        asserted at `codec.go:518`.
- [x] 1.7 Add fixtures for the messages no fixture covers today: `Ack`,
      `ClientHello`, `ServerHello`, `Limits`, `Capabilities`, `AppEvent`.
      `Ack` is live and its field numbers are asserted nowhere.
- [x] 1.8 Add a guard asserting `.proto` field numbers match the codec tables in
      **both** languages. Today the only proto→Go path runs through a TypeScript
      test and covers oneof arms plus 7 limit values — no inner field number in
      either codec is checked against the schema.
- [x] 1.9 Prove each new guard fails when its fix is reverted. Do the revert in
      a disposable copy, never in the shared tree.
- [x] 1.9b Resolve the `PublicMeta` reserved-range trap:
      `scripts/acceptance.selftest.ts:210-212` requires field numbers "1..n with
      no gap", which forbids the `reserved` gap protobuf requires on removal.
      Decide now how a `PublicMeta` field would ever be retired.
- [x] 1.10 Fix the three stale status headers that send readers to the wrong
      conclusion: `lib/ccwire/codecParity.selftest.ts:27-28` and
      `adversarialParity.selftest.ts:28` still say "NOT WIRED … the live
      transport remains Socket.IO v4 with JSON payloads". Socket.IO is gone;
      `'ccwire'` is the only `TransportName`.
- [x] 1.11 `npx tsc --noEmit`, `npm test`, `go test ./...` — report actual
      commands, exit status, counts and skips. No historical totals.

### Wave 1 result (written; NOT deployed, NOT device-verified)

Done: toolchain gate passed; `@bufbuild/buf` + `@bufbuild/protoc-gen-es` added
dev-only; `@bufbuild/protobuf@1.10.1` declared directly (already shipped via
LiveKit, so zero new APK bytes); `google.golang.org/protobuf v1.36.12` added to
`go.mod`; 7 schemas generated for TS and 7 for Go; `npm run proto:gen` /
`proto:check` added and wired into `npm test`; two new guards
(`protoConformance.selftest.ts`, `generatedParity.selftest.ts`).

Every guard was proven to fail on revert: TS drift, Go drift, a changed field
number, a deleted generated file, and a removed KNOWN entry.

Wave 1 is COMPLETE. 1.7 added 7 vectors (4 Ack, 2 hello, 1 encode) at the
routing-header layer — Ack cannot go in `bodies` without breaking Go's
`TypedBodies` check and the `[100]` pin. 1.9b made the PublicMeta guard accept
a `reserved` gap while still refusing an unreserved gap, a reuse, a reserved
LIVE number, and a `reserved` that only appears in a comment. 1.10 corrected
FIVE stale headers, not two.

AppEvent (100) still has no vector and cannot get one from the fixture file:
Go fails any decode vector with a non-empty body 100, and `bodies` is closed to
it by two pins. Closing that gap means typing app_event in Go and Rust.

Also flagged, out of scope here: `vaultchat-backend-go/internal/jobs/
meta_public_proto_test.go` has no contiguity check, so a PublicMeta field-number
reuse is caught only on the TypeScript side.

## Wave 2 — Shared Go operation and transport compatibility

Entry: Wave 1 exit met. Exit: characterization tests green; the decision to
extract or keep the loopback made on evidence.

- [x] 2.1 Characterization tests for `chatsMessagePost` against the **real**
      handler, not `fakeRoutes`. Cover what nothing covers today: the happy path
      end to end, `ON CONFLICT` idempotency, the per-type validation ladder
      (`chats_helpers.go:589-730`), the announcement/audience gate, the
      duplicate branch, transaction atomicity, and the async unread/push tails.
- [x] 2.2 Test the loopback against the real mux. No test wires
      `SetCCWireRoutes` to the real `cw` mux today; the two meet only in prod.
- [x] 2.3 Fix the observability gap: CC-Wire sends produce **no** HTTP metrics,
      because `metrics.Wrap` wraps only the public mux
      (`cmd/api/main.go:447`). Independent of protobuf; do it here because this
      is where the tests land.
- [x] 2.4 Decide extraction on the evidence from 2.1–2.2. If extracting, the
      seam must include the rate limit (`:436`), block check (`:460`) and 2 MB
      body cap (`httpx.go:94`) — otherwise it trades an unavoidable gate set for
      three gates every future caller must remember.

### Wave 2 result (2.3 verified; 2.1/2.2 WRITTEN, NOT VERIFIED)

**2.3 is done and verified.** CC-Wire sends contributed nothing to HTTP metrics
because `metrics.Wrap` is applied only at `cmd/api/main.go:447` while the
loopback serves the private `cw` mux directly (`ccwire_messages.go:112`).
Fixed by wrapping each CC-Wire route with a constant `"ccwire "` route-label
prefix, so those sends get their own latency series instead of being folded
into the HTTP ones. No existing label set changed, so no dashboard or PromQL
query breaks. Two guards, both proven to fail on revert — one catches the mux
losing instrumentation, the other catches a NEW CC-Wire route being registered
without it.

**2.1/2.2 are written and compile, but their assertions have NEVER EXECUTED.**
They pin: `ON CONFLICT` idempotency, the duplicate re-read
(`chats_helpers.go:772-796`), the deliberate asymmetry where fan-out fires on a
duplicate (`:869`, outside the guard) while the unread bump does not (`:872`),
17 validation-ladder refusals with their exact Node-parity strings, commit-together
atomicity, and a CC-Wire submission reaching the REAL handler rather than
`fakeRoutes`. Their SQL is unverified until they run against a scratch database.

**Why they could not run — and this is a standing constraint, not a one-off:**
Docker is unavailable in this environment, so the disposable database on port
15499 cannot be created. The only reachable Postgres is on **15432, which this
repo documents as an SSH tunnel to PRODUCTION**, and it was observed OPEN.
These tests write. They were therefore not run, deliberately.

**Safety defect found while establishing that, and fixed:**
`vaultchat-backend/.env` sets `DB_PORT=15432`, and `loadtest/seed.js` called
`dotenv.config()` before any check while its own header described 15432 as "the
docker-compose bench stack". With no environment variables at all, that script
— which INSERTs 1000 users — resolved to production. It now fails closed.
`migrate.js` inherits the same port deliberately (mutating prod is its job; it
documents this at its lines 9-10) and was left alone.

**2.4 remains BLOCKED** and must stay blocked: the extraction decision depends
on 2.1/2.2 having actually run.

## Wave 3 — Integration checkpoints

Entry: Wave 2 exit met. Checkpoints, not completion.

- [x] 3.1 One read-only HTTP operation end to end with negotiated
      `application/protobuf`. NOT through `lib/api.ts` — GET /app/version is a
      raw fetch in lib/appVersion.ts, chosen deliberately so the funnel that
      331 contracts share was not touched. JSON retained for peers that do not
      negotiate. (This line previously claimed the funnel, contradicting the
      result note below it.)
- [ ] 3.2 One server-originated typed event moved **off body 100 onto a typed
      body that already exists** in Go and already has parity vectors.
- [ ] 3.3 One message-submission operation spanning CC-Wire and HTTP.
- [x] 3.4 Use isolated test accounts and synthetic fixtures only. Never send a
      benchmark message to a real contact.

### Wave 3 result — 3.1 done, 3.2 HALF, and 4.1 is now BLOCKED

**3.1 done and verified.** GET /app/version negotiates binary protobuf.
Deliberately chosen because its client is a raw fetch() in lib/appVersion.ts,
NOT api() — so the first protobuf endpoint ships without touching the funnel
331 contracts depend on. lib/api.ts is byte-for-byte unmodified. The JSON path
is pinned at the BYTE level across four Accept variations, and the exact wire
bytes are asserted in BOTH the Go test and the TS selftest so the two sides
cannot drift onto different field numbers. The generated codec loads through a
dynamic import() at lib/appVersionPolicy.ts:95, so @bufbuild/protobuf stays off
the cold path — verified: nothing outside gen/** imports it at module scope.

**3.2 is HALF DONE, and the missing half is a protocol gap, not an oversight.**
The receive side is implemented: lib/ccwire/transport.ts now decodes body 81
TypingState and dispatches it through the same facade as the app_event JSON
form, so consumers changed not at all. The EMIT side could not be built, for a
reason verified at source:

  THERE IS NO CAPABILITY BIT MEANING "this server accepts typed app-domain
  bodies inbound". Capabilities fields 1-8 are all assigned
  (proto/ccwire/v1/capabilities.proto:13-23). `app_events_v1` (8) asserts the
  server speaks app_event JSON — the OPPOSITE of what a typed emit needs — so
  gating on it would be repurposing a published flag. Field 15 `experimental`
  is specified INERT ("echoed back unmodified but never activated", :26-27), so
  it cannot carry activation either. Separately, client.ts surfaces only
  `appEventsV1` and `resumption` on ServerHello (:153, :170), so transport.ts
  could not read a new bit even if one existed.

No wire flag was invented. That is correct: the spec requires representation to
be negotiated, never guessed, and a client emitting a body the server may not
accept is exactly the guess it forbids.

**CONSEQUENCE — Wave 4.1 is BLOCKED on a protocol decision.** Retiring client
use of body 100 requires adding a capability bit first. Smallest compatible
addition: `bool typed_app_bodies = 9;` in Capabilities, written by the Go
session unconditionally (already true of serveBody), decoded in client.ts onto
ServerHello, read by eventsSocket/transport to gate emit. Intersection
semantics hold: an old server omits it, a new client falls back to body 100.
This touches .proto + codec.ts + client.ts and is a published-schema change —
it needs an explicit decision, not an agent.

### Batch A/C progress (written; NOT deployed, NOT device-verified)

**Batch A — DONE.** `wireId` added as a sibling in `lib/msgIds.ts`
(`normalizeMsgIds` untouched for its existing callers), plus
`lib/ccwire/startupAdapter.ts` and three test suites. Two release gates caught
real defects BEFORE anything shipped:

- `chatsCacheRollback.selftest.ts` caught the adapter narrowing
  `lastMessageId`/`myLastReadId` to numbers. The server emits them as JSON
  STRINGS and `cacheChats` persists the row verbatim, so an older build reading
  its own cache would have got a type it never wrote. Fixed: pass through.
  Then a second-order bug the fix exposed — `?? null` is not enough, because
  proto3 encodes absence as `''` which is not nullish, and `'' ?? Infinity` is
  `''`, which compares FALSE against any pointer, so an unread badge would
  never clear. Changed to `|| null`.
- `syncCursorRegression.selftest.ts` found a LIVE data-loss hole in existing
  code, proven against real SQLite: `Number.isFinite` let through `'123.5'`
  (fractional durable cursor), `'9007199254740995'` (rounded UP — the monotonic
  high-water mark moved PAST an id never delivered, skipping that message
  permanently on every future launch), and `1e21` (a mark that suppresses all
  future delta rows). `nextSince <= since` could not catch the rounding because
  it rounds FORWARD. Fixed with one word: `Number.isSafeInteger`.

**Batch C — server half DONE, client half in progress.**
`proto/ccwire/v1/chats_list.proto` written by the lead (28 fields, `optional`
exactly where the handler emits JSON null, plain where it already collapsed the
null before serialising). `chatsListWrite` negotiates on the same route with the
existing `protobufMediaType` gate; the typed reply is built from the same rows
with no JSON round trip; JSON byte-identity asserted across four Accept variants.

The id asymmetry is PRESERVED, not normalised: `lastMessageId`/`myLastReadId`
stay JSON strings, `peerLast*` stay JSON numbers, all four are
`int64 [jstype = JS_STRING]` on the wire, and the client adapter maps each back
to its JSON counterpart's shape. An unparseable id becomes ABSENT, never 0 —
a fabricated 0 would silently clear an unread badge.

Cross-language byte pin verified by the lead: Go's exact bytes decode in the TS
codec and re-encode identically, with every nil field genuinely absent.

## Wave 4 — Paired domain migrations

Entry: Wave 3 checkpoints green. Migrate producer-to-consumer operations, never
frontend-only or backend-only batches. Sequenced by traffic, not alphabetically.

- [ ] 4.1 BLOCKED on the capability bit (see Wave 3 result). Retire client use of body 100 for the events that already
      have typed bodies in Go (32, 33, 50, 51, 52, 64, 81, 82, 84).
- [ ] 4.1a Add a hand-written Go reader for INBOUND Capabilities field 9
      before the server is ever made to emit typed bodies. Today Go advertises
      9 but cannot read a client's 9 (helloAppEvents reads 1+8,
      helloWantsResumption reads 2). Server-to-client intersection is therefore
      unenforced; it is safe only because the client always negotiates
      app_events_v1 and the server answers those sessions with app_event.
- [ ] 4.2 Chats/messages HTTP (105 client contracts).
- [ ] 4.3 User/account (47), auth (16), social graph (24).
- [ ] 4.4 ShopBook (76) — **blocked on the money representation decision**. A
      monetary field must carry or reach its currency AND scale: the code
      hard-codes two decimals for every currency (`shopbook_money.go:42,46,52,
      76,80`; all columns `NUMERIC(n,2)`), so BHD/KWD/JOD/TND (3) and
      JPY/KRW/VND (0) are unrepresentable. Do not encode a bare integer and
      call it exact.
- [ ] 4.5 Remaining domains: broadcasts/golive (17), media/uploads (14),
      calls (12), stories (9), games (4), nav (4), misc (3).
- [ ] 4.6 The six documented `api()` bypasses (`chatService.ts:1907,2827,2865`,
      `face-verify-new-device.tsx:61`, `deviceService.ts:62,83`) — decide per
      site: route through the funnel, or record as a permanent exception.

## Wave 5 — Persistent records, queues, backups

Entry: Wave 4 substantially complete for the owning domain.

- [ ] 5.1 Reuse `ensureFtsReadyLocked`'s five properties verbatim: per-page
      committed cursor, generation guard, locked-cache refusal, single-flight,
      fail-open. Do not write a new mechanism.
- [ ] 5.2 Reuse the `enc:v1:` prefix pattern for coexistence. Lazy
      write-through; no bulk rewrite.
- [ ] 5.3 **Never touch `queues.data` without special care** — `unseal()`
      silently skips unparseable rows and keeps them, so a corrupting bug makes
      an unsent message invisible with no error.
- [ ] 5.4 Backups: `v: 4` is written and never read
      (`cloudBackup.ts:257` vs `applyEncryptedBackup`, which feature-detects).
      Start reading it before relying on it.
- [ ] 5.5 Keep every old-format reader permanently. `messages` has no reaper and
      `importAll` can reintroduce old rows from any backup at any time.
- [ ] 5.6 No new table, column or schema migration. If a path genuinely needs
      one, document it and leave it **pending** — do not execute it.

## Wave 6 — E2EE content (GATED)

Entry gate, all four required:

- [ ] 6.1 A per-recipient-device capability signal exists and is tested. The
      key-bundle response (`user.go:2440-2445`) and the SKDM
      (`senderKey.ts:79-83`) are the two places that would carry it; the group
      membership GET is already on the hot path, so it costs no round trip.
- [ ] 6.2 Group intersection over **all member devices**, since one format is
      emitted for everyone (`senderKey.ts:6-9`).
- [ ] 6.3 `messageStore.ts:50-59` framing made NUL-safe (length-prefixed), or
      the content format guaranteed NUL-free.
- [ ] 6.4 Session-layer APIs made binary-clean (`e2eeSession.ts:508/614`,
      `senderKey.ts:126/180`); the ratchet core beneath already is.
- [ ] 6.5 Only then: emit a new inner format, to devices known to decode it.
- [ ] 6.6 Never re-encrypt historical messages to retire an old reader.

## Wave 7 — Retirement

- [ ] 7.1 Retire a legacy path only when client compatibility, queued data,
      stored records and the rollback window all allow it. The rollback window
      is real and measured in hours: `lib/featureFlags.ts:31-35` — a kill switch
      lands on the next cold start and "cannot un-send anything".
- [ ] 7.2 Every remaining JSON site carries boundary, reason, owner and either a
      permanent justification or a named retirement condition. No
      directory-wide exemptions.
- [ ] 7.3 Do not remove compatibility early to report "zero JSON", and do not
      keep it forever to avoid deciding.

## September 20 compatibility audit — written and local verification only

This batch reviews the existing cold-start migration across the app, Go API,
legacy Node/deployment configuration, PostgreSQL mappings and SQLite caches.
It does not complete the unrelated migration waves above.

- [x] 8.1 Reject a malformed typed chat-list row before a partial list can
      replace/prune the SQLite cache; extend the existing real-caller selftest.
- [x] 8.2 Preserve existing Vary fields and repeated Accept headers in the
      shared Go negotiation helper; verify migrated endpoint compatibility.
- [x] 8.3 Verify schema generation, deployment routing and DB migration
      tooling; fix demonstrated tooling defects without adding dependencies.
- [x] 8.4 Run frontend tests, type checking, lint, Go tests and OpenSpec
      validation; record failures/skips and perform a Ponytail diff review.
- [x] 8.5 Fix the VaultBeam progress-mask SQL failure reproduced by the
      expanded DB audit: PostgreSQL has no `bytea | bytea` operator. Preserve
      mask bit ordering, concurrent merges and session-version checks; verify
      the existing receiver/upload progress and resume regression tests.
- [x] 8.6 Make the HTTP-only receiver-mask builders emit the raw base64 the Go
      handler accepts; preserve tagged/RLE bitmap encodings used by storage and
      realtime paths, and check both sparse and dense masks.

No SQL migration is required by this audit. Production and device verification
remain separate from these local checks.

### Audit evidence

- `npm test`: exit 0, 341/341 suites (263 selftests, 78 embedded checks);
  backend HTTP/socket contracts and all 34 generated TS/Go files match.
  Its default DB phase skipped because local 5432 requires a password and
  Docker timed out; the separate scratch DB run below covers that phase.
- `npm run typecheck`: exit 0 (SDK versions and `tsc --noEmit`).
- `go test ./...`: exit 0, 22 packages, 14 with tests. Focused negotiation
  tests also pass across all 10 migrated endpoints.
- Fresh PostgreSQL 18, bound only to `127.0.0.1:15499` in a unique temporary
  directory: all 136 migrations through 137 applied, ledger/checksums agree,
  no pending migrations, and all 17 SQL regression files pass.
- Scratch Go integration: 19 top-level tests plus 18 validation subtests pass,
  including the real HTTP and CC-Wire send handlers, idempotency, transaction
  atomicity, membership refusals, undelivered recovery and cursor pagination.
  This supersedes the historical Wave 2 "never executed" note above. Decision
  2.4: keep the tested loopback and its shared validation/middleware; extraction
  is unnecessary for this compatibility repair.
- Final DB-enabled `go test -p 1 ./internal/routes -count=1 -json
  -timeout 300s`: exit 0, 424 top-level tests and 67 subtests pass, zero skips.
  Combined with unaffected packages from `go test -p 1 ./... -count=1 -json
  -timeout 300s` and a separate retention-test database, final results are
  860 top-level tests plus 634 subtests passing. Seven environment skips remain:
  one separate RLS role, five Redis tests, and Rust WebTransport availability.
  Test-only vault keys/pepper were supplied for onboarding fixtures; one
  VaultBeam test ID was corrected to the handler's existing 16-character
  minimum. The temporary PostgreSQL cluster was stopped after verification.
- The chat-list regression passes against the fix and fails five assertions
  against the old source in a disposable copy. Persisted JSON/cache encryption,
  message IDs, sync cursors, queues and backup formats remain unchanged.
- The expanded DB run also exposed an existing VaultBeam failure: PostgreSQL
  rejects `bytea | bytea`. The shared mask UPDATE now unions integer bytes with
  `get_byte`, keeps byte order and zero-extension, and rebuilds BYTEA without
  moving the merge out of the atomic UPDATE. No stored format changes.
- Receiver HTTP mask builders now use the existing raw-base64 encoder, matching
  the Go handler. Their embedded check plus `noRetransmit` and `directFallback`
  suites pass; reverting the two encoder calls in a disposable copy fails eight
  assertions. Local and realtime tagged/RLE encodings remain intact.
- `npm run lint`: exit 1, two existing JSX comment errors in
  `app/live/join/[code].tsx:145` and `app/story-viewer.tsx:384`, plus 285
  warnings. Neither error is in a file changed by this audit.
- OpenSpec full validation: 39/42 pass; existing failures are
  `fix-presence-publish-stall`, `harden-audit-findings` and
  `responsive-breadth-and-toolchain`. `protobuf-migration` validates strictly.
- Ponytail review: shared-boundary fixes, existing tests/dependencies reused,
  no schema additions or new framework. Caddy/compose still route HTTP to Go;
  the undeployed Node backend retains its existing contract.

Production file-copy candidates are `internal/routes/appversion.go` and
`internal/routes/vaultbeam.go` within the Go source deployment, and
`scripts/check-migration-drift.js` for deployment
tooling. Frontend `lib/chatService.ts` and `lib/vaultBeam/reportReceived.ts`
fixes require a future app build.
These files have only been changed locally; no production ledger was queried,
no production files/data were changed, and no device verification was claimed.

### Residual VaultBeam concurrency risk (source review, not reproduced)

`vbRelayUploaded` checks a loaded session version before asynchronous object
HEAD requests, but its mask/ready UPDATEs are scoped only by transfer id.
`vbRelayGrow` writes a previously read whole mask and can race with uploads.
`vbRelayComplete`/`vbRelayAbort` operate on an unversioned object prefix, so a
concurrent re-init can also race with object cleanup. Adding a SQL version
predicate alone would not protect those objects. These pre-existing generation
and object-lifetime races need a coordinated lifecycle fix with concurrency
tests (serialized cleanup/reset or versioned object keys), rather than a
partial guard in this serialization repair. The fixes above do not establish
full VaultBeam concurrency safety.

## September 20 follow-up — complete verification and backend deployment

- [x] 9.1 Rerun frontend, Go, SQL and Rust checks; enable isolated services for
      previously skipped checks where available and report remaining limits.
- [x] 9.2 Capture the live source/image/configuration and migration baseline,
      prepare an immutable candidate snapshot and retain rollback state.
- [x] 9.3 Deploy only the reviewed Go backend changes; verify direct/public
      health, readiness, authentication and JSON/Protobuf compatibility.

Prepared release: `protobuf-audit-20260920`, source fingerprint
`6492ff85dbd9db44`. Read-only production comparison found only the two reviewed
runtime files and three regression-test files differ. Baseline running source
is `cef79a23c035eff2`; the original image and source files are retained under
`/home/srihari/vaultchat-releases/protobuf-audit-20260920` with a rollback script.
The candidate builds successfully in isolation with the existing Dockerfile.
Compose configuration and transport flags are preserved; rollout recreates
only `go-api` and applies no database migrations.

DEPLOYED at approximately `2026-09-20T18:32Z` (`2026-09-21 00:02 IST`).
Both direct and public `/build` identify `6492ff85dbd9db44`; `/health` and
`/ready` report healthy DB/Redis. `/app/version` and `/app/flags` JSON bytes
match the pre-deploy capture, explicitly negotiated Protobuf succeeds with
`Vary: Accept`, and unauthenticated `/user/profile` and `/chats` still return
401. Fresh focused regressions also passed in the isolated candidate Go build
container without network/service access. Rollback remains available with
`python3 /home/srihari/vaultchat-releases/protobuf-audit-20260920/release.py rollback`.
Frontend changes still require an app release; no device verification is claimed.

Fresh follow-up frontend verification: `npm test` passes all 341 suites and all
17 SQL regression files with the disposable DB explicitly required (no DB skip),
plus both backend contract checks and 34 generated-file checks. Typecheck passes.
Lint now passes with zero errors and 285 existing warnings after correcting two
stray JSX comments without changing application logic. The separate RLS-role
test and all five real Redis tests also pass, closing six previous skips.
Container-ID comparison confirms only `vaultchat-go-api-1` was recreated.
The post-deployment soak check remains healthy with DB/Redis ready and zero
container restarts. Legacy Node vault crypto checks pass all 26 assertions;
syntax checks pass for 16 JavaScript files. The legacy Socket.IO benchmark
harness requires obsolete routes and seeded fixtures and is not applicable to
the deployed Go service; it was not run against production.

Fresh full Go run passes 1,494 test results (860 top-level tests and 634
subtests). All seven environment-gated skips were then executed separately and
passed: RLS, five real Redis tests, and Go/Rust WebTransport interoperability.
The latter verifies invalid CA rejection, invalid JWT rejection, and valid
split/pipelined Hello/Ping exchange. No gated Go check remains unverified.
The ignored verified-WSS test also passes against
`wss://api.corefinite.com/ccwire/v1` using its hardcoded invalid token: trusted
TLS succeeds and authentication correctly rejects it. No real user credentials
or data writes are involved. Both disposable PostgreSQL and Redis are stopped.

All six Rust crate test stages and strict Clippy (`-D warnings`) pass using the installed GNU toolchain and
MinGW linker (the MSVC linker is unavailable on this host). Vaultcore passes
14 tests, transport-net 13 default tests, crypto 18 tests, navigation 22 tests,
and VaultBeam 27 tests; transport-core suites also pass. Navigation's ignored
timing benchmark was separately exercised successfully in debug mode, without
claiming performance evidence. Optional WSS and WebTransport checks are
covered above. No tracked Rust source, dependency, or lockfile changes were
needed for verification.
The complete `npm run test:rust` chain exits zero. Repository-wide OpenSpec
validation remains 39/42: the three existing planning changes
`fix-presence-publish-stall`, `harden-audit-findings`, and
`responsive-breadth-and-toolchain` lack delta specs. This change's strict
validation passes. Frontend lint retains 285 existing warnings, with no errors.

Production DB preflight found 136 ledger entries through 137. All file checksums
match except existing migration 135 metadata (`ba5f19a58b91e8ed` in the ledger,
`38d54d51d7925640` for the current file). The production migration file matches
the checkout, and a read-only `pg_get_functiondef` comparison confirms the live
three-argument `vc_bump_unread` body, SECURITY DEFINER and pinned search path
match the migration. No ledger or function rewrite is part of this deployment.
The new mask expression also produced the expected `0581ff` in a read-only
constant-input query on production PostgreSQL 16.

## Other delivery work

- [x] 10.1 AUTHORIZED — build a release APK from the reviewed working tree
      and retain its checksum.
- [ ] 10.4 Install the APK on the user's connected Android phone, preserving
      existing app data. No physical device is connected yet.
- [ ] 10.2 AUTHORIZED — inventory every screen, exercise reachable screens and
      transitions on Android, and record observed results and access blockers.
- [ ] 10.3 AUTHORIZED — inspect runtime errors and cold-start behavior, fix
      confirmed regressions, and retest affected paths.

APK build completed September 21 at 01:22 IST: version 1.2.15 (31), ARM64,
97,524,115 bytes. SHA-256:
`3fb762dbdb5d8654cb1fd71fb0d9cdd3efcbf8dd8c1d36980839a31d56d3f01d`.
APK signature verification passes (v2); manifest confirms ARM64-only package
`com.vaultchat.app`, minimum SDK 24, target SDK 36.
Artifact: `../deployment-snapshots/apk-screen-audit-20260921/crazzychat-1.2.15-protobuf-arm64.apk`.
The initial two-ABI build was deliberately stopped after the user rejected
emulator testing; the emulator was stopped. ARM64-only build succeeded in
14m56s, with 76 tasks executed and 1,930 up-to-date. No clean prebuild or native
rewrite was performed. A 187-route screen inventory is retained alongside the
APK; screen execution remains pending physical-device connection and access.
- [x] AUTHORIZED — backend deployment tracked in 9.2–9.3 above; app release
      and unrelated production configuration changes remain outside this batch.
- [ ] User requested physical-phone testing instead of emulator testing;
      emulator stopped. Physical-device verification awaits USB connection. Reuse the
      `coldstart-evidence` instrumentation when it is authorized; keep first
      frame, authorized cached-list readiness, authenticated CC-Wire readiness
      and catch-up as separate milestones.
- [ ] NOT AUTHORIZED — any production data or schema migration.

## Recorded for separate changes, not this one

- `internal/routes/chats.go:1114-1115` — `PeerLastReadMessageID` /
  `PeerLastDeliveredMessageID` emitted as JSON numbers while sibling ids are
  strings. One `,string` tag each plus `lib/chatService.ts:46-47`.
- `shopbook.go:1320-1335`, `shopbook_jobs.go:190,204-205` — money accumulated in
  `float64` and emitted unrounded or via `%.0f`, contradicting
  `shopbook_money.go:5-10`.
- `db/financeDb.ts:52-131` — eleven `REAL` money columns.
- `shopbook_money.go:449-458` — `sbRoundOff` applies the Indian
  round-to-the-rupee rule to every currency; gated on `round_off_enabled`, not
  on country. A USD shop with the flag set gets Indian rounding.
- `utils/native/MoneyCore.ts:52-53` — money crosses the Nitro/JSI bridge as
  JSON decimal rupees, and `:57` float-compares a money value in the probe.
- `services/transport/rust/src/metrics.rs` — entirely unreferenced.
